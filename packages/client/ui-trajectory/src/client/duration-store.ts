import {
  createSnapshotStore, type SnapshotStore,
} from '@hydra1902/harness-client-runtime/client'

/**
 * Create the browser-wide trajectory duration preference source.
 * @returns a persisted source shared by every session view in one plugin lifecycle.
 */
export function createTrajectoryDurationStore(): SnapshotStore<boolean> {
  return createSnapshotStore(false, {
    persist: { name: 'hydra.trajectory.duration' },
  })
}
