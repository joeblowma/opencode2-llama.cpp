import {access} from 'fs/promises'
import {constants} from 'fs'
import type {LlamaCppModel, LlamaCppUnloadableModel} from '../types'

/**
 * Flags models a router-mode `llama-server` advertises but cannot serve.
 *
 * Router mode happily lists a preset whose `--model` path no longer exists on
 * disk. Nothing in `/v1/models` reports this: the entry looks identical to a
 * healthy one, and the failure only surfaces later as HTTP 500
 * `model name=… failed to load` on the first real request. Registering it in
 * the catalog means offering the user a selection that is guaranteed to fail.
 *
 * The check is therefore a local existence test on the advertised `--model`
 * path — no request, so it cannot itself trigger an autoload, and it works
 * whether or not the model happens to be resident.
 *
 * **Deliberately conservative.** Only a definitive "missing" is reported:
 *  - a model with no readable `--model` arg is left alone (unverifiable)
 *  - a non-`file:` URL is left alone (remote weights, nothing to stat)
 *  - a stat error other than ENOENT is left alone (permissions, not absence)
 *
 * A false positive here means hiding a model the user could otherwise have
 * loaded, so anything short of proof is treated as possibly-fine.
 */

/** Pull the `--model` path out of a model's launch argv. */
export function extractModelPath(model: LlamaCppModel): string | undefined {
    const args = model.status?.args
    if (!Array.isArray(args)) return undefined

    const index = args.indexOf('--model')
    if (index === -1) return undefined

    const value = args[index + 1]
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Test whether one advertised model can actually be loaded.
 *
 * Split from {@link findUnloadableModels} so the filesystem is never touched
 * from the pure catalog transform.
 */
export async function isUnloadable(model: LlamaCppModel): Promise<LlamaCppUnloadableModel | null> {
    const modelPath = extractModelPath(model)
    if (!modelPath) return null

    // Remote weights have no local file to stat.
    if (!/^file:|^[a-z]:[\\/]|^\/|^\.\.?[\\/]/i.test(modelPath)) return null

    try {
        // `F_OK` only tests existence — a permissions error must not be
        // mistaken for absence, which would hide a perfectly good model.
        await access(modelPath, constants.F_OK)
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return {model, modelPath}
        }
        // EACCES, ELOOP, a too-long path, … all mean "cannot tell".
        return null
    }

    return null
}

/**
 * Partition discovered models into servable and provably-unloadable.
 *
 * Failures are reported rather than thrown: a discovery sweep must never fail
 * because one preset points at a bad path.
 */
export async function findUnloadableModels(
    models: readonly LlamaCppModel[],
): Promise<{loadable: LlamaCppModel[]; unloadable: LlamaCppUnloadableModel[]}> {
    const settled = await Promise.all(models.map(async (model) => ({
        model,
        problem: await isUnloadable(model),
    })))

    return {
        loadable: settled.filter((s) => !s.problem).map((s) => s.model),
        unloadable: settled.filter((s) => s.problem).map((s) => s.problem!),
    }
}