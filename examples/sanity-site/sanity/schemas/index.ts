import { blockSchemas } from "./blocks"
import { pageSchema } from "./page"
import { siteConfigSchema } from "./siteConfig"

export const schemaTypes = [...blockSchemas, pageSchema, siteConfigSchema]
