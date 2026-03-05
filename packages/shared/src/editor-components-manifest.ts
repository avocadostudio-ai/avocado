import { z } from "zod"

export const jsonSchemaLikeSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    properties: z.record(jsonSchemaLikeSchema).optional(),
    required: z.array(z.string()).optional(),
    items: z.union([jsonSchemaLikeSchema, z.array(jsonSchemaLikeSchema)]).optional(),
    enum: z.array(z.unknown()).optional(),
    anyOf: z.array(jsonSchemaLikeSchema).optional(),
    oneOf: z.array(jsonSchemaLikeSchema).optional(),
    allOf: z.array(jsonSchemaLikeSchema).optional(),
    additionalProperties: z.union([z.boolean(), jsonSchemaLikeSchema]).optional(),
    description: z.string().optional()
  }).catchall(z.unknown())
)

export const editorComponentSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1).optional(),
  editablePaths: z.array(z.string().min(1)).optional(),
  propsSchema: jsonSchemaLikeSchema,
  defaultProps: z.record(z.unknown()).optional()
})

export const editorComponentsManifestSchema = z.object({
  version: z.number().int().positive(),
  components: z.array(editorComponentSchema)
})

export type EditorComponentDefinition = z.infer<typeof editorComponentSchema>
export type EditorComponentsManifest = z.infer<typeof editorComponentsManifestSchema>

