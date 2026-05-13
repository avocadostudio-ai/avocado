import assert from "node:assert/strict"
import test from "node:test"

import { getAllBlockMeta } from "@avocadostudio-ai/shared"
import { rendererBlockTypes } from "../../../packages/blocks/src/blocks/block-types.ts"

test("renderer types stay in sync with registered block types", () => {
  const registeredTypes = Object.keys(getAllBlockMeta()).sort()
  const renderedTypes = [...rendererBlockTypes].sort()
  assert.deepEqual(renderedTypes, registeredTypes)
})
