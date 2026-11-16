/**
 * Web host text for the boot errors of `bootHost` (R-BOOT-3). Core throws
 * facts and holds no text. The web host owns this renderer because
 * `ma-host-text-plugin` can be the missing plugin.
 *
 * Also the boot options of the web host: core holds no fallback text, so the
 * web boot requires every text contract (`TEXT_CONTRACTS`).
 *
 * @module backend/boot-error-text
 */

import { CoreError, type CoreErrorJson, isCoreErrorJson } from "@minimal-agent/core/errors"
import { type HostBootOptions, TEXT_CONTRACTS } from "@minimal-agent/core/host-kit/host-boot"

/** The contract options every web boot passes to `bootHost`. */
export const WEB_BOOT_CONTRACTS: Pick<HostBootOptions, "requiredContracts"> = {
  requiredContracts: TEXT_CONTRACTS,
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

/** Web text of a `ContractCheckFailedError` JSON. Names every contract. */
export function contractCheckFailedText(err: CoreErrorJson): string {
  const parts = ["required plugin contracts are not met"]
  const missing = ids(err.fields.missing)
  const duplicates = ids(err.fields.duplicates)
  if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`)
  if (duplicates.length > 0) parts.push(`duplicated in one plugin tier: ${duplicates.join(", ")}`)
  return `${parts.join("; ")}. Install or enable the text plugins in the embedded plugin root.`
}

/**
 * Text of a boot failure: a `ContractCheckFailedError` gets its web text,
 * another error gives its message (or its name when the message is empty).
 */
export function bootErrorText(error: unknown): string {
  const json: unknown = error instanceof CoreError ? error.toJSON() : error
  if (isCoreErrorJson(json) && json.kind === "ContractCheckFailedError") {
    return contractCheckFailedText(json)
  }
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
