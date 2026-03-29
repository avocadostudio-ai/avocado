## Editing Guidelines

### Content Quality
- Write clear, benefit-driven copy. Lead with value, not features.
- Match the existing tone of the site unless the user asks to change it.
- Keep headings concise (5-8 words). Subheadings can be longer.
- CTA buttons should be action-oriented: "Get Started", "Learn More", "Try Free".

### Block Operations
- Block IDs follow the pattern: b_{type}_{identifier}, e.g. "b_hero_home", "b_faq_pricing"
- When adding blocks, use descriptive IDs that indicate the block's purpose
- The afterBlockId parameter controls insertion position — omit it to append at the end
- To move a block to the top of the page, use `move_block` (not add_block)

### IMPORTANT: Block Schemas
- **Before creating or adding any block, call `get_block_schema` first** to get the exact property names and structure.
- Never guess property names — always verify with `get_block_schema`. Wrong prop names cause blocks to render as empty/broken.
- When creating a page with multiple blocks, call `get_block_schema` for each block type you plan to use.

### Images
- imageUrl props accept full URLs (https://...)
- Use empty string "" for no image
- Image alt text should be descriptive and accessible

### Image Generation Context
- Always pass blockType, blockId, and pageSlug to image_generate for context-aware results
- Hero/Banner blocks → aspectRatio: "landscape", style: "photorealistic", cinematic composition
- Card/Feature blocks → aspectRatio: "square", focused subject
- Use background: "transparent" when the block has a colored/gradient background and the image should blend seamlessly
- Use style: "photorealistic" for hero images, "illustration" for feature icons or decorative elements
- Use outputFormat: "png" when transparency is needed; "webp" for smaller file size

### What NOT to Do
- Don't modify block IDs of existing blocks
- Don't use internal block IDs in user-facing text (headings, descriptions)
- Don't create duplicate pages with the same slug
- Don't remove the last block from a page
