import { NextRequest, NextResponse } from 'next/server'
import { getExecution, approveExecution, rejectExecution } from '@/lib/ai-workforce'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const execution = await getExecution(id)
    if (!execution) {
      return NextResponse.json({ success: false, error: 'Execution not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: execution })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const { action, reviewedBy, note } = body
    if (!action || !reviewedBy) {
      return NextResponse.json({ success: false, error: 'action and reviewedBy are required' }, { status: 400 })
    }
    if (action === 'approve') {
      const result = await approveExecution(id, reviewedBy)
      return NextResponse.json({ success: true, data: result })
    } else if (action === 'reject') {
      const result = await rejectExecution(id, reviewedBy, note || 'Rejected by reviewer')
      return NextResponse.json({ success: true, data: result })
    } else {
      return NextResponse.json({ success: false, error: 'action must be approve or reject' }, { status: 400 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
