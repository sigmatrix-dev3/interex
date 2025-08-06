import { data, useLoaderData, useActionData, Form, useSearchParams, Link } from 'react-router'
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { getFormProps, getInputProps, getSelectProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Field, ErrorList, SelectField, TextareaField } from '#app/components/forms.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { useState, useEffect } from 'react'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { Drawer } from '#app/components/ui/drawer.tsx'

// Validation schema for creating a new submission
const CreateSubmissionSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  purposeOfSubmission: z.enum([
    'ADR', 'UNSOLICITED_PWK_XDR', 'PA_AMBULANCE', 'HHPCR', 'PA_DMEPOS', 
    'HOPD', 'FIRST_APPEAL', 'SECOND_APPEAL', 'ADMC', 'RA_DISCUSSION', 'DME_DISCUSSION'
  ]),
  recipient: z.string().min(1, 'Recipient is required'),
  providerId: z.string().min(1, 'NPI selection is required'),
  claimId: z.string().optional(),
  caseId: z.string().max(32, 'Case ID cannot exceed 32 characters').optional(),
  comments: z.string().optional(),
  // New CMS HIH specific fields
  category: z.enum(['DEFAULT', 'MEDICAL_REVIEW', 'NON_MEDICAL_REVIEW', 'RESPONSES_FOR_PA']).default('DEFAULT'),
  autoSplit: z.boolean().default(false),
  sendInX12: z.boolean().default(false),
  threshold: z.number().int().min(1).default(100),
  intent: z.literal('create'),
})

// Validation schema for file upload
const FileUploadSchema = z.object({
  submissionId: z.string().min(1, 'Submission ID is required'),
  intent: z.literal('upload-file'),
})

// Validation schema for file deletion
const FileDeleteSchema = z.object({
  documentId: z.string().min(1, 'Document ID is required'),
  intent: z.literal('delete-file'),
})

// Validation schema for submission deletion
const SubmissionDeleteSchema = z.object({
  submissionId: z.string().min(1, 'Submission ID is required'),
  intent: z.literal('delete-submission'),
})

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  
  // Check if user has permission to view submissions
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { 
      roles: true,
      customer: true,
      providerGroup: true,
      userNpis: {
        include: {
          provider: true
        }
      }
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Allow system admin, customer admin, provider group admin, and basic user roles
  const hasRequiredRole = user.roles.some(role => 
    ['system-admin', 'customer-admin', 'provider-group-admin', 'basic-user'].includes(role.name)
  )
  
  if (!hasRequiredRole) {
    throw new Response('Insufficient permissions', { status: 403 })
  }

  // Determine filtering based on user role
  const isSystemAdmin = user.roles.some(role => role.name === 'system-admin')
  const isCustomerAdmin = user.roles.some(role => role.name === 'customer-admin') || isSystemAdmin // System admin has customer admin access
  const isProviderGroupAdmin = user.roles.some(role => role.name === 'provider-group-admin') || isCustomerAdmin // Customer admin and system admin have provider group admin access

  if (!user.customerId && !isSystemAdmin) {
    throw new Response('User must be associated with a customer', { status: 400 })
  }

  let whereClause = {} as any

  if (isSystemAdmin) {
    // System admin can see all submissions
    whereClause = {}
  } else if (user.customerId) {
    whereClause = {
      customerId: user.customerId,
    }

    if (isProviderGroupAdmin && user.providerGroupId) {
      // Provider group admins can only see submissions for their provider group
      whereClause.provider = {
        providerGroupId: user.providerGroupId
      }
    } else if (!isCustomerAdmin) {
      // Basic users can only see submissions for their assigned NPIs
      const userProviderIds = user.userNpis.map(un => un.providerId)
      whereClause.providerId = {
        in: userProviderIds
      }
    }
  }

  // Get submissions with related data
  const submissions = await prisma.submission.findMany({
    where: whereClause,
    include: {
      creator: {
        select: {
          id: true,
          username: true,
          name: true
        }
      },
      provider: {
        select: {
          id: true,
          npi: true,
          name: true
        }
      },
      documents: {
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          createdAt: true
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  })

  // Get user's available NPIs for creating new submissions
  const availableNpis = isSystemAdmin
    ? await prisma.provider.findMany({
        select: { id: true, npi: true, name: true }
      })
    : isCustomerAdmin && user.customerId
    ? await prisma.provider.findMany({
        where: { customerId: user.customerId },
        select: { id: true, npi: true, name: true }
      })
    : isProviderGroupAdmin && user.providerGroupId && user.customerId
    ? await prisma.provider.findMany({
        where: { 
          customerId: user.customerId,
          providerGroupId: user.providerGroupId 
        },
        select: { id: true, npi: true, name: true }
      })
    : user.userNpis.map(un => ({
        id: un.provider.id,
        npi: un.provider.npi,
        name: un.provider.name
      }))

  return data({
    user,
    submissions,
    availableNpis,
    isCustomerAdmin,
    isProviderGroupAdmin
  })
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { 
      roles: true,
      customer: true,
      providerGroup: true,
      userNpis: {
        include: {
          provider: true
        }
      }
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Check permissions
  const hasRequiredRole = user.roles.some(role => 
    ['system-admin', 'customer-admin', 'provider-group-admin', 'basic-user'].includes(role.name)
  )
  
  if (!hasRequiredRole) {
    throw new Response('Insufficient permissions', { status: 403 })
  }

  if (!user.customerId && !user.roles.some(role => role.name === 'system-admin')) {
    throw new Response('User must be associated with a customer', { status: 400 })
  }

  const formData = await request.formData()
  const intent = formData.get('intent')

  if (intent === 'delete-submission') {
    // Handle submission deletion
    const submissionDeleteSubmission = parseWithZod(formData, { schema: SubmissionDeleteSchema })
    
    if (submissionDeleteSubmission.status !== 'success') {
      return data(
        { result: submissionDeleteSubmission.reply() },
        { status: submissionDeleteSubmission.status === 'error' ? 400 : 200 }
      )
    }

    const { submissionId } = submissionDeleteSubmission.value

    // Verify submission exists and user has access
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { 
        provider: true,
        documents: true
      }
    })

    if (!submission) {
      return data(
        { result: submissionDeleteSubmission.reply({ formErrors: ['Submission not found'] }) },
        { status: 404 }
      )
    }

    // Check if user has access to this submission
    if (submission.customerId !== user.customerId) {
      return data(
        { result: submissionDeleteSubmission.reply({ formErrors: ['Access denied'] }) },
        { status: 403 }
      )
    }

    // Check if submission is in draft state
    if (submission.status !== 'DRAFT') {
      return data(
        { result: submissionDeleteSubmission.reply({ formErrors: ['Only draft submissions can be deleted'] }) },
        { status: 400 }
      )
    }

    // Verify user has access to this submission's provider
    const isSystemAdmin = user.roles.some(role => role.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(role => role.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(role => role.name === 'provider-group-admin') || isCustomerAdmin
    
    if (!isSystemAdmin) {
      if (isProviderGroupAdmin && user.providerGroupId) {
        if (submission.provider.providerGroupId !== user.providerGroupId) {
          return data(
            { result: submissionDeleteSubmission.reply({ formErrors: ['Access denied to this submission'] }) },
            { status: 403 }
          )
        }
      } else if (!isCustomerAdmin) {
        const hasAccess = user.userNpis.some(un => un.providerId === submission.providerId)
        if (!hasAccess) {
          return data(
            { result: submissionDeleteSubmission.reply({ formErrors: ['Access denied to this submission'] }) },
            { status: 403 }
          )
        }
      }
    }

    // Log submission deletion for now (will be replaced with actual file cleanup later)
    console.log('Submission deletion metadata:', {
      submissionId,
      title: submission.title,
      documentCount: submission.documents.length,
      deletedBy: userId,
      deletedAt: new Date()
    })

    // Delete submission and all related documents (cascade delete should handle this)
    await prisma.submission.delete({
      where: { id: submissionId }
    })

    return redirectWithToast('/customer/submissions', {
      type: 'success',
      title: 'Submission Deleted',
      description: `Submission "${submission.title}" has been deleted successfully.`,
    })
  }

  if (intent === 'delete-file') {
    // Handle file deletion
    const fileDeleteSubmission = parseWithZod(formData, { schema: FileDeleteSchema })
    
    if (fileDeleteSubmission.status !== 'success') {
      return data(
        { result: fileDeleteSubmission.reply() },
        { status: fileDeleteSubmission.status === 'error' ? 400 : 200 }
      )
    }

    const { documentId } = fileDeleteSubmission.value

    // Verify document exists and user has access
    const document = await prisma.submissionDocument.findUnique({
      where: { id: documentId },
      include: { 
        submission: { 
          include: { provider: true } 
        } 
      }
    })

    if (!document) {
      return data(
        { result: fileDeleteSubmission.reply({ formErrors: ['Document not found'] }) },
        { status: 404 }
      )
    }

    // Check if user has access to this document's submission
    if (document.submission.customerId !== user.customerId) {
      return data(
        { result: fileDeleteSubmission.reply({ formErrors: ['Access denied'] }) },
        { status: 403 }
      )
    }

    // Check if submission is in draft state
    if (document.submission.status !== 'DRAFT') {
      return data(
        { result: fileDeleteSubmission.reply({ formErrors: ['Files can only be deleted from draft submissions'] }) },
        { status: 400 }
      )
    }

    // Verify user has access to this submission's provider
    const isSystemAdmin = user.roles.some(role => role.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(role => role.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(role => role.name === 'provider-group-admin') || isCustomerAdmin
    
    if (!isSystemAdmin) {
      if (isProviderGroupAdmin && user.providerGroupId) {
        if (document.submission.provider.providerGroupId !== user.providerGroupId) {
          return data(
            { result: fileDeleteSubmission.reply({ formErrors: ['Access denied to this document'] }) },
            { status: 403 }
          )
        }
      } else if (!isCustomerAdmin) {
        const hasAccess = user.userNpis.some(un => un.providerId === document.submission.providerId)
        if (!hasAccess) {
          return data(
            { result: fileDeleteSubmission.reply({ formErrors: ['Access denied to this document'] }) },
            { status: 403 }
          )
        }
      }
    }

    // Log file deletion for now (will be replaced with actual file deletion later)
    console.log('File deletion metadata:', {
      documentId,
      fileName: document.fileName,
      submissionId: document.submissionId,
      deletedBy: userId,
      deletedAt: new Date()
    })

    // Delete document record from database
    await prisma.submissionDocument.delete({
      where: { id: documentId }
    })

    return redirectWithToast(`/customer/submissions?view=${document.submissionId}`, {
      type: 'success',
      title: 'File Deleted',
      description: `${document.fileName} has been deleted successfully.`,
    })
  }

  if (intent === 'upload-file') {
    // Handle file upload
    const fileUploadSubmission = parseWithZod(formData, { schema: FileUploadSchema })
    
    if (fileUploadSubmission.status !== 'success') {
      return data(
        { result: fileUploadSubmission.reply() },
        { status: fileUploadSubmission.status === 'error' ? 400 : 200 }
      )
    }

    const { submissionId } = fileUploadSubmission.value
    const file = formData.get('file') as File

    if (!file || file.size === 0) {
      return data(
        { result: fileUploadSubmission.reply({ formErrors: ['Please select a file to upload'] }) },
        { status: 400 }
      )
    }

    // Verify submission exists and user has access
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { provider: true }
    })

    if (!submission || submission.customerId !== user.customerId) {
      return data(
        { result: fileUploadSubmission.reply({ formErrors: ['Submission not found or access denied'] }) },
        { status: 404 }
      )
    }

    // Check if submission is in draft state
    if (submission.status !== 'DRAFT') {
      return data(
        { result: fileUploadSubmission.reply({ formErrors: ['Files can only be uploaded to draft submissions'] }) },
        { status: 400 }
      )
    }

    // Verify user has access to this submission's provider
    const isSystemAdmin = user.roles.some(role => role.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(role => role.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(role => role.name === 'provider-group-admin') || isCustomerAdmin
    
    if (!isSystemAdmin) {
      if (isProviderGroupAdmin && user.providerGroupId) {
        if (submission.provider.providerGroupId !== user.providerGroupId) {
          return data(
            { result: fileUploadSubmission.reply({ formErrors: ['Access denied to this submission'] }) },
            { status: 403 }
          )
        }
      } else if (!isCustomerAdmin) {
        const hasAccess = user.userNpis.some(un => un.providerId === submission.providerId)
        if (!hasAccess) {
          return data(
            { result: fileUploadSubmission.reply({ formErrors: ['Access denied to this submission'] }) },
            { status: 403 }
          )
        }
      }
    }

    // Log file metadata for now (will be replaced with FHIR upload later)
    console.log('File upload metadata:', {
      submissionId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      lastModified: new Date(file.lastModified),
      uploadedBy: userId,
      uploadedAt: new Date()
    })

    // Create document record in database
    const document = await prisma.submissionDocument.create({
      data: {
        submissionId,
        fileName: file.name,
        originalFileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        uploaderId: userId,
        // For now, we'll set a placeholder path since we're not actually storing the file
        objectKey: `/temp/${submissionId}/${file.name}`,
      }
    })

    return redirectWithToast(`/customer/submissions?view=${submissionId}`, {
      type: 'success',
      title: 'File Uploaded',
      description: `${file.name} has been uploaded successfully.`,
    })
  }

  // Handle submission creation
  const submission = parseWithZod(formData, { schema: CreateSubmissionSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { title, purposeOfSubmission, recipient, providerId, claimId, caseId, comments, category, autoSplit, sendInX12, threshold } = submission.value

  // Verify the user has access to the selected provider
  const isSystemAdmin = user.roles.some(role => role.name === 'system-admin')
  const isCustomerAdmin = user.roles.some(role => role.name === 'customer-admin') || isSystemAdmin
  const isProviderGroupAdmin = user.roles.some(role => role.name === 'provider-group-admin') || isCustomerAdmin
  
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { providerGroup: true }
  })

  if (!provider || (provider.customerId !== user.customerId && !isSystemAdmin)) {
    return data(
      { result: submission.reply({ formErrors: ['Invalid provider selection'] }) },
      { status: 400 }
    )
  }

  // Additional permission checks
  if (!isSystemAdmin) {
    if (isProviderGroupAdmin && user.providerGroupId) {
      if (provider.providerGroupId !== user.providerGroupId) {
        return data(
          { result: submission.reply({ formErrors: ['You can only create submissions for providers in your group'] }) },
          { status: 400 }
        )
      }
    } else if (!isCustomerAdmin) {
      // Basic users can only create submissions for their assigned NPIs
      const hasAccess = user.userNpis.some(un => un.providerId === providerId)
      if (!hasAccess) {
        return data(
          { result: submission.reply({ formErrors: ['You can only create submissions for your assigned NPIs'] }) },
          { status: 400 }
        )
      }
    }
  }

  // Create the submission
  const newSubmission = await prisma.submission.create({
    data: {
      title,
      purposeOfSubmission,
      recipient,
      claimId: claimId || null,
      caseId: caseId || null,
      comments: comments || null,
      category,
      autoSplit,
      sendInX12,
      threshold,
      creatorId: userId,
      providerId,
      customerId: isSystemAdmin ? provider.customerId : user.customerId!,
    },
  })

  return redirectWithToast(`/customer/submissions/${newSubmission.id}`, {
    type: 'success',
    title: 'Submission Created',
    description: 'Your submission has been created successfully. You can now add documents to it.',
  })
}

export default function Submissions() {
  const { user, submissions, availableNpis, isCustomerAdmin, isProviderGroupAdmin } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams, setSearchParams] = useSearchParams()
  const isPending = useIsPending()
  
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'all')
  const [purposeFilter, setPurposeFilter] = useState(searchParams.get('purpose') || 'all')
  const [selectedPurpose, setSelectedPurpose] = useState('')

  // Drawer state management
  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'view'
    selectedSubmission?: any
  }>({ isOpen: false, mode: 'create', selectedSubmission: null })

  // Handle URL parameters for drawer state
  useEffect(() => {
    const action = searchParams.get('action')
    const viewId = searchParams.get('view')
    
    if (action === 'create') {
      setDrawerState({ isOpen: true, mode: 'create', selectedSubmission: null })
    } else if (viewId) {
      const submission = submissions.find((s: any) => s.id === viewId)
      if (submission) {
        setDrawerState({ isOpen: true, mode: 'view', selectedSubmission: submission })
      }
    } else {
      setDrawerState({ isOpen: false, mode: 'create', selectedSubmission: null })
    }
  }, [searchParams, submissions])

  const openCreateDrawer = () => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('action', 'create')
    newParams.delete('view')
    setSearchParams(newParams)
  }

  const openViewDrawer = (submission: any) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('view', submission.id)
    newParams.delete('action')
    setSearchParams(newParams)
  }

  const closeDrawer = () => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('action')
    newParams.delete('view')
    setSearchParams(newParams)
  }

  // Form setup
  const [form, fields] = useForm({
    id: 'create-submission',
    constraint: getZodConstraint(CreateSubmissionSchema),
    lastResult: actionData?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateSubmissionSchema })
    },
    shouldRevalidate: 'onBlur',
  })

  const filteredSubmissions = submissions.filter((submission: any) => {
    if (statusFilter !== 'all' && submission.status !== statusFilter) return false
    if (purposeFilter !== 'all' && submission.purposeOfSubmission !== purposeFilter) return false
    return true
  })

  const handleFilterChange = (type: string, value: string) => {
    const newSearchParams = new URLSearchParams(searchParams)
    if (value === 'all') {
      newSearchParams.delete(type)
    } else {
      newSearchParams.set(type, value)
    }
    setSearchParams(newSearchParams)
    
    if (type === 'status') setStatusFilter(value)
    if (type === 'purpose') setPurposeFilter(value)
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'DRAFT': return 'bg-gray-100 text-gray-800'
      case 'SUBMITTED': return 'bg-blue-100 text-blue-800'
      case 'PROCESSING': return 'bg-yellow-100 text-yellow-800'
      case 'COMPLETED': return 'bg-green-100 text-green-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const formatSubmissionPurpose = (purpose: string) => {
    return purpose.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  }

  const formatStatus = (status: string) => {
    return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  }

  // Determine which fields are required based on submission purpose
  const requiresClaimId = ['ADR', 'PWK_CLAIM_DOCUMENTATION', 'FIRST_APPEAL', 'SECOND_APPEAL', 'DME_DISCUSSION', 'RA_DISCUSSION'].includes(selectedPurpose)

  const submissionPurposes = [
    { value: 'ADR', label: 'ADR - Additional Documentation Request' },
    { value: 'PA_ABT', label: 'PA ABT - Prior Authorization for Ambulatory Services' },
    { value: 'PA_DMEPOS', label: 'PA DMEPOS - Prior Authorization for DME/Prosthetics/Orthotics & Supplies' },
    { value: 'HH_PRE_CLAIM', label: 'HH Pre-Claim - Home Health Pre-Claim' },
    { value: 'HOPD', label: 'HOPD - Hospital Outpatient Department' },
    { value: 'PWK_CLAIM_DOCUMENTATION', label: 'PWK Claim Documentation' },
    { value: 'FIRST_APPEAL', label: '1st Appeal' },
    { value: 'SECOND_APPEAL', label: '2nd Appeal' },
    { value: 'DME_DISCUSSION', label: 'DME Discussion' },
    { value: 'RA_DISCUSSION', label: 'RA Discussion' },
    { value: 'ADMC', label: 'ADMC - Advance Determination of Medical Coverage' },
    { value: 'IRF', label: 'IRF - Inpatient Rehabilitation Facility' },
  ]

  return (
    <>
      {/* Main content area - blur when drawer is open */}
      <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
        <InterexLayout 
          user={user}
          title="Submissions"
          subtitle="Manage and track your HIH submissions"
          currentPath="/customer/submissions"
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
            <div className="space-y-8">
              {/* Filters */}
              <div className="bg-white shadow rounded-lg p-6">
                <div className="flex flex-col gap-4 sm:flex-row">
                  <div className="flex-1">
                    <label htmlFor="status-filter" className="block text-sm font-medium text-gray-700">
                      Filter by Status
                    </label>
                    <select
                      id="status-filter"
                      value={statusFilter}
                      onChange={(e) => handleFilterChange('status', e.target.value)}
                      className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm shadow-sm"
                    >
                      <option value="all">All Statuses</option>
                      <option value="DRAFT">Draft</option>
                      <option value="SUBMITTED">Submitted</option>
                      <option value="PROCESSING">Processing</option>
                      <option value="COMPLETED">Completed</option>
                    </select>
                  </div>
                  <div className="flex-1">
                    <label htmlFor="purpose-filter" className="block text-sm font-medium text-gray-700">
                      Filter by Purpose
                    </label>
                    <select
                      id="purpose-filter"
                      value={purposeFilter}
                      onChange={(e) => handleFilterChange('purpose', e.target.value)}
                      className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm shadow-sm"
                    >
                      <option value="all">All Purposes</option>
                      <option value="ADR">ADR</option>
                      <option value="PA_ABT">PA ABT</option>
                      <option value="PA_DMEPOS">PA DMEPOS</option>
                      <option value="HH_PRE_CLAIM">HH Pre-Claim</option>
                      <option value="HOPD">HOPD</option>
                      <option value="PWK_CLAIM_DOCUMENTATION">PWK Claim Documentation</option>
                      <option value="FIRST_APPEAL">1st Appeal</option>
                      <option value="SECOND_APPEAL">2nd Appeal</option>
                      <option value="DME_DISCUSSION">DME Discussion</option>
                      <option value="RA_DISCUSSION">RA Discussion</option>
                      <option value="ADMC">ADMC</option>
                      <option value="IRF">IRF</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Submissions List */}
              <div className="bg-white shadow rounded-lg">
                <div className="px-6 py-4 border-b border-gray-200">
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900">Submissions</h2>
                      <p className="text-sm text-gray-500">{filteredSubmissions.length} submission{filteredSubmissions.length !== 1 ? 's' : ''}</p>
                    </div>
                    <div className="flex space-x-3">
                      <button
                        onClick={openCreateDrawer}
                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                      >
                        <Icon name="plus" className="h-4 w-4 mr-2" />
                        Create Submission
                      </button>
                    </div>
                  </div>
                </div>
                
                {filteredSubmissions.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <Icon name="file-text" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No submissions found</h3>
                    <p className="text-gray-500 mb-6">
                      {statusFilter !== 'all' || purposeFilter !== 'all' 
                        ? 'No submissions match your current filters.' 
                        : 'Get started by creating your first submission.'
                      }
                    </p>
                    <button
                      onClick={openCreateDrawer}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
                    >
                      <Icon name="plus" className="h-4 w-4 mr-2" />
                      Create Submission
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto shadow-sm">
                    <div className="inline-block min-w-full align-middle">
                      <table className="min-w-full divide-y divide-gray-200 table-fixed" style={{ minWidth: '900px' }}>
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/4">
                              Title
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/6">
                              Purpose
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/6">
                              NPI
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/8">
                              Status
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">
                              Documents
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/8">
                              Created
                            </th>
                            <th className="relative px-4 py-3 text-right w-20">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {filteredSubmissions.map((submission: any) => (
                            <tr key={submission.id} className="hover:bg-gray-50">
                              <td className="px-4 py-4">
                                <div className="text-sm font-medium text-gray-900 max-w-[200px] truncate" title={submission.title}>
                                  {submission.title}
                                </div>
                                {submission.claimId && (
                                  <div className="text-xs text-gray-500">
                                    Claim: {submission.claimId}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-4">
                                <div className="text-sm text-gray-900">
                                  <span className="inline-block px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded-full whitespace-nowrap">
                                    {formatSubmissionPurpose(submission.purposeOfSubmission)}
                                  </span>
                                </div>
                              </td>
                              <td className="px-4 py-4">
                                <div className="text-sm font-mono text-gray-900">
                                  {submission.provider.npi}
                                </div>
                                {submission.provider.name && (
                                  <div className="text-xs text-gray-500 max-w-[140px] truncate" title={submission.provider.name}>
                                    {submission.provider.name}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-4">
                                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full whitespace-nowrap ${getStatusColor(submission.status)}`}>
                                  {formatStatus(submission.status)}
                                </span>
                              </td>
                              <td className="px-4 py-4">
                                <div className="text-sm text-gray-900 flex items-center">
                                  <Icon name="file-text" className="h-4 w-4 mr-1 text-gray-400" />
                                  {submission.documents.length}
                                </div>
                              </td>
                              <td className="px-4 py-4 text-sm text-gray-500">
                                <div className="flex flex-col">
                                  <span className="whitespace-nowrap">{new Date(submission.createdAt).toLocaleDateString()}</span>
                                  <span className="text-xs text-gray-400 whitespace-nowrap">
                                    {new Date(submission.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </div>
                              </td>
                              <td className="px-4 py-4 text-right w-20">
                                <div className="flex items-center justify-end space-x-2">
                                  <button
                                    onClick={() => openViewDrawer(submission)}
                                    className="inline-flex items-center px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 rounded hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 whitespace-nowrap"
                                  >
                                    <Icon name="arrow-right" className="h-3 w-3 mr-1" />
                                    View
                                  </button>
                                  {/* Show delete button only for draft submissions */}
                                  {submission.status === 'DRAFT' && (
                                    <Form method="POST" className="inline">
                                      <input type="hidden" name="intent" value="delete-submission" />
                                      <input type="hidden" name="submissionId" value={submission.id} />
                                      <button
                                        type="submit"
                                        className="inline-flex items-center px-2 py-1 text-xs font-medium text-red-600 bg-red-50 rounded hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 whitespace-nowrap"
                                        title="Delete submission"
                                        onClick={(e) => {
                                          if (!confirm(`Are you sure you want to delete "${submission.title}"? This action cannot be undone.`)) {
                                            e.preventDefault()
                                          }
                                        }}
                                      >
                                        <Icon name="trash" className="h-3 w-3" />
                                      </button>
                                    </Form>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </InterexLayout>
      </div>

      {/* Create/View Submission Drawer */}
      <Drawer
        isOpen={drawerState.isOpen}
        onClose={closeDrawer}
        title={drawerState.mode === 'create' ? 'Create New Submission' : `Submission: ${drawerState.selectedSubmission?.title || ''}`}
        size="lg"
      >
        {drawerState.mode === 'create' ? (
          <Form method="POST" {...getFormProps(form)}>
            <input type="hidden" name="intent" value="create" />
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'Title *' }}
                inputProps={{
                  ...getInputProps(fields.title, { type: 'text' }),
                  placeholder: 'Enter submission title',
                }}
                errors={fields.title.errors}
              />

              <SelectField
                labelProps={{ children: 'Purpose of Submission *' }}
                selectProps={{
                  ...getSelectProps(fields.purposeOfSubmission),
                  onChange: (e) => setSelectedPurpose(e.target.value),
                }}
                errors={fields.purposeOfSubmission.errors}
              >
                <option value="">Select purpose</option>
                {submissionPurposes.map(purpose => (
                  <option key={purpose.value} value={purpose.value}>
                    {purpose.label}
                  </option>
                ))}
              </SelectField>

              <Field
                labelProps={{ children: 'Recipient *' }}
                inputProps={{
                  ...getInputProps(fields.recipient, { type: 'text' }),
                  placeholder: 'Enter receiving partner',
                }}
                errors={fields.recipient.errors}
              />

              <SelectField
                labelProps={{ children: 'NPI *' }}
                selectProps={getSelectProps(fields.providerId)}
                errors={fields.providerId.errors}
              >
                <option value="">Select NPI</option>
                {availableNpis.map(provider => (
                  <option key={provider.id} value={provider.id}>
                    {provider.npi}{provider.name ? ` - ${provider.name}` : ''}
                  </option>
                ))}
              </SelectField>

              {requiresClaimId && (
                <Field
                  labelProps={{ children: selectedPurpose === 'ADR' ? 'Claim ID *' : 'Claim ID' }}
                  inputProps={{
                    ...getInputProps(fields.claimId, { type: 'text' }),
                    placeholder: '8, 13-15, or 17-23 characters',
                  }}
                  errors={fields.claimId.errors}
                />
              )}

              <Field
                labelProps={{ children: 'Case ID' }}
                inputProps={{
                  ...getInputProps(fields.caseId, { type: 'text' }),
                  placeholder: 'Up to 32 characters (optional)',
                  maxLength: 32,
                }}
                errors={fields.caseId.errors}
              />

              <TextareaField
                labelProps={{ children: 'Comments' }}
                textareaProps={{
                  ...getInputProps(fields.comments, { type: 'text' }),
                  placeholder: 'Additional notes (optional)',
                  rows: 3,
                }}
                errors={fields.comments.errors}
              />

              <div className="flex items-center justify-end gap-4 pt-4 border-t border-gray-200">
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <StatusButton
                  type="submit"
                  disabled={isPending}
                  status={isPending ? 'pending' : 'idle'}
                  className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
                >
                  Create Submission
                </StatusButton>
              </div>

              <ErrorList errors={form.errors} id={form.errorId} />
            </div>
          </Form>
        ) : (
          drawerState.selectedSubmission && (
            <div className="space-y-6">
              {/* Submission Details */}
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Title</label>
                    <p className="text-sm text-gray-900">{drawerState.selectedSubmission.title}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Status</label>
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(drawerState.selectedSubmission.status)}`}>
                      {formatStatus(drawerState.selectedSubmission.status)}
                    </span>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Purpose</label>
                    <p className="text-sm text-gray-900">{formatSubmissionPurpose(drawerState.selectedSubmission.purposeOfSubmission)}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Recipient</label>
                    <p className="text-sm text-gray-900">{drawerState.selectedSubmission.recipient}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">NPI</label>
                    <p className="text-sm text-gray-900">{drawerState.selectedSubmission.provider.npi}</p>
                    {drawerState.selectedSubmission.provider.name && (
                      <p className="text-xs text-gray-500">{drawerState.selectedSubmission.provider.name}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Created</label>
                    <p className="text-sm text-gray-900">{new Date(drawerState.selectedSubmission.createdAt).toLocaleDateString()}</p>
                  </div>
                  {drawerState.selectedSubmission.claimId && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Claim ID</label>
                      <p className="text-sm text-gray-900">{drawerState.selectedSubmission.claimId}</p>
                    </div>
                  )}
                  {drawerState.selectedSubmission.caseId && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Case ID</label>
                      <p className="text-sm text-gray-900">{drawerState.selectedSubmission.caseId}</p>
                    </div>
                  )}
                </div>
                {drawerState.selectedSubmission.comments && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700">Comments</label>
                    <p className="text-sm text-gray-900">{drawerState.selectedSubmission.comments}</p>
                  </div>
                )}
              </div>

              {/* File Upload Section - Only show for DRAFT submissions */}
              {drawerState.selectedSubmission.status === 'DRAFT' && (
                <div className="border-t border-gray-200 pt-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">Upload Documents</h3>
                  <Form method="POST" encType="multipart/form-data">
                    <input type="hidden" name="intent" value="upload-file" />
                    <input type="hidden" name="submissionId" value={drawerState.selectedSubmission.id} />
                    
                    <div className="space-y-4">
                      <div>
                        <label htmlFor="file" className="block text-sm font-medium text-gray-700">
                          Select File
                        </label>
                        <input
                          type="file"
                          id="file"
                          name="file"
                          required
                          className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          Supported formats: PDF, DOC, DOCX, TXT, JPG, JPEG, PNG, TIFF, XLS, XLSX
                        </p>
                      </div>
                      
                      <div className="flex justify-end">
                        <StatusButton
                          type="submit"
                          disabled={isPending}
                          status={isPending ? 'pending' : 'idle'}
                          className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                        >
                          Upload File
                        </StatusButton>
                      </div>
                    </div>
                  </Form>
                </div>
              )}

              {/* Documents List */}
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Documents ({drawerState.selectedSubmission.documents.length})</h3>
                
                {drawerState.selectedSubmission.documents.length === 0 ? (
                  <div className="text-center py-6">
                    <Icon name="file-text" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <p className="text-gray-500">No documents uploaded yet</p>
                    {drawerState.selectedSubmission.status === 'DRAFT' && (
                      <p className="text-xs text-gray-400 mt-2">Use the upload form above to add documents</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {drawerState.selectedSubmission.documents.map((doc: any) => (
                      <div key={doc.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center">
                          <Icon name="file-text" className="h-5 w-5 text-gray-400 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-900">{doc.fileName}</p>
                            <p className="text-xs text-gray-500">
                              {(doc.fileSize / 1024).toFixed(1)} KB • {new Date(doc.createdAt).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        {/* Show delete button only for draft submissions */}
                        {drawerState.selectedSubmission.status === 'DRAFT' && (
                          <Form method="POST" className="ml-4">
                            <input type="hidden" name="intent" value="delete-file" />
                            <input type="hidden" name="documentId" value={doc.id} />
                            <button
                              type="submit"
                              className="text-red-600 hover:text-red-800 p-1"
                              title="Delete file"
                              onClick={(e) => {
                                if (!confirm(`Are you sure you want to delete ${doc.fileName}?`)) {
                                  e.preventDefault()
                                }
                              }}
                            >
                              <Icon name="trash" className="h-4 w-4" />
                            </button>
                          </Form>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-4 pt-4 border-t border-gray-200">
                {/* Show delete button only for draft submissions */}
                {drawerState.selectedSubmission.status === 'DRAFT' && (
                  <Form method="POST" className="mr-auto">
                    <input type="hidden" name="intent" value="delete-submission" />
                    <input type="hidden" name="submissionId" value={drawerState.selectedSubmission.id} />
                    <button
                      type="submit"
                      className="inline-flex items-center px-3 py-2 text-sm font-semibold text-red-600 bg-red-50 rounded-md hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500"
                      onClick={(e) => {
                        if (!confirm(`Are you sure you want to delete the submission "${drawerState.selectedSubmission.title}"? This action cannot be undone.`)) {
                          e.preventDefault()
                        }
                      }}
                    >
                      <Icon name="trash" className="h-4 w-4 mr-2" />
                      Delete Submission
                    </button>
                  </Form>
                )}
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          )
        )}
      </Drawer>
    </>
  )
}
