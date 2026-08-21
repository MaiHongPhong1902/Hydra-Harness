import { Context } from '@bosch/cordis'
import { SettingsSchemaService } from '@bosch/bh-client-ui-settings/src/client/schema.ts'
import { createSettingsSchemaOperations } from '../src/client/schema-operations.ts'

/** Stateless schema operations used by settings-model component fixtures. */
export const settingsSchema = createSettingsSchemaOperations(new SettingsSchemaService(new Context()))
