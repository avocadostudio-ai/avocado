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
- To insert at the top, omit afterBlockId in add_block

### Array Properties (Lists)
- FAQ items use: { q: "Question?", a: "Answer." }
- Feature items use: { title: "Feature", description: "Details" }
- Card items use: { title: "Card", description: "Details", imageUrl: "", ctaText: "Learn More", ctaHref: "/" }
- Testimonial items use: { quote: "...", author: "Name", role: "Title" }

### Images
- imageUrl props accept full URLs (https://...)
- Use empty string "" for no image
- Image alt text should be descriptive and accessible

### Honoring user-supplied image URLs
When the user or reporter gave you an image URL (in the prompt, description, or a ticket comment), use *their* URL — do not silently substitute a search result:
- **Direct image URL** (ends in .jpg/.jpeg/.png/.webp/.gif, or host is `images.unsplash.com`, a CDN, etc.) → use it verbatim in `imageUrl`.
- **Unsplash photo page URL** (`https://unsplash.com/photos/...`) → call `unsplash_get_by_id` first to resolve it to a direct asset URL, then use that. Never assign a `unsplash.com/photos/...` URL to `imageUrl` — it's an HTML page and will break `<img>`.
- **Anything else** (a broken link, a Pinterest/Google redirect, a page URL that isn't an image) → ask the user to provide a direct image URL instead of silently falling back to a search. Only search or generate if the user clearly asked for that, or explicitly declined to provide a URL.

When you do fall back to search because no URL was given, say so in the summary (e.g. "No image URL was provided, so I searched Unsplash for 'tropical beach'").

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
