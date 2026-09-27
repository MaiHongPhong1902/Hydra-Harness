import { BrandWordmark } from '@hydra1902/harness-client-ui-primitives'

/**
 * Render the Hydra harness name and mark in the sidebar.
 * @param props - Optional layout class.
 * @returns the shared brand wordmark.
 */
export function HydraSidebarBrand({ className }: { className?: string | undefined }) {
  return <BrandWordmark className={className} />
}
