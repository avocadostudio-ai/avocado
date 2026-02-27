# Section Terminology and Naming Conventions

## Current State (As Implemented)

- The current data model is block-list based:
  - `PageDoc.blocks: BlockInstance[]`
- Current operations target page/block identifiers and do not yet include section identifiers.
- `sectionKey` and `PageDoc.sections` are **not implemented yet**.

## Canonical Term

- Use **Section** as the single canonical term across product, UX copy, API contracts, and internal docs.
- Avoid using: `zone`, `dynamic zone`, `area`, or mixed terminology in new work.

## Product/UI Language

- Preferred labels:
  - "Add section"
  - "Move section"
  - "Section settings"
  - "Section rules"
- Preferred contextual phrasing:
  - "Add this below in the Body section."
  - "Move this block to the Footer section."

## Code Naming

### Target Conventions (Planned)

- Use `sectionKey` as the canonical identifier name.
- Use `sections` for grouped block collections.
- Use `sectionRules` for schema/validation constraints.

### Recommended shapes

- `PageDoc.sections: Record<string, BlockInstance[]>`
- `Operation.sectionKey: string` (for add/move/remove/update operations where section context matters)

## Key Patterns

- Prefer singular for identifiers:
  - `sectionKey`
  - `sectionId` (if needed)
- Prefer plural for collections:
  - `sections`
  - `allowedSections`
- Keep block naming unchanged:
  - `BlockInstance`
  - `blockId`
  - `blockType`

## Migration/Compatibility Note

- During transition, map legacy `zone*` naming to `section*` at boundaries, then remove legacy aliases once all clients are updated.

## Example Vocabulary Mapping

- "Dynamic zones" -> "Flexible sections"
- "Zone constraints" -> "Section rules"
- "Zone-aware operations" -> "Section-aware operations"
