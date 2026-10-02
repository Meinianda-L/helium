import { NextRequest, NextResponse } from 'next/server'
import { releaseLock } from '@/app/lib/lock/lock-actions'

export async function POST(req: NextRequest): Promise<NextResponse> {
    let data
    try {
        data = await req.json()
    } catch {
        return NextResponse.json({ error: 'invalid-request' }, { status: 400 })
    }
    try {
        await releaseLock({
            entityType: data.entityType,
            entityId: data.entityId,
            token: data.token
        })
    } finally {
    }
    return new NextResponse(null, { status: 204 })
}
