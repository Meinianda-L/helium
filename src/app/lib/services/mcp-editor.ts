import 'server-only'

import { Role } from '@/generated/prisma/client'
import {
    replaceDocumentSchema,
    editDocumentSchema,
    entityIdSchema,
    languageSchema,
    type OperationActor
} from '@/app/lib/mcp/contracts'
import { z } from 'zod'
import { requireActorUser } from '@/app/lib/services/actor'

export const readEditorDocumentSchema = z.object({
    entityId: entityIdSchema, language: languageSchema, editor: z.enum([ 'plate', 'puck' ])
}).strict()

export async function operateEditorDocument(actor: OperationActor, action: 'read' | 'edit' | 'replace', raw: unknown): Promise<Record<string, unknown>> {
    await requireActorUser(actor, Role.writer)
    const input = action === 'read' ? readEditorDocumentSchema.parse(raw) : action === 'replace' ? replaceDocumentSchema.parse(raw) : editDocumentSchema.parse(raw)
    const configured = process.env.HOCUSPOCUS_INTERNAL_URL ?? process.env.NEXT_PUBLIC_HOCUSPOCUS_URL
    if (!configured || !process.env.JWT_SECRET) return {
        ok: false, error: {
            code: 'storage_unavailable', message: 'Configure the collaboration server before editing live documents.'
        }
    }
    const url = configured.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '') + '/mcp/editor'
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-collaboration-secret': process.env.JWT_SECRET },
        body: JSON.stringify({
            action,
            actor: { source: actor.source, userId: actor.userId, tokenId: actor.tokenId },
            input
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) return {
        ok: false, error: {
            code: 'storage_unavailable',
            message: 'The collaboration server could not confirm the operation. Retry edits with the same idempotency key.'
        }
    }
    return await response.json() as Record<string, unknown>
}
