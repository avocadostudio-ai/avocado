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

### What NOT to Do
- Don't modify block IDs of existing blocks
- Don't use internal block IDs in user-facing text (headings, descriptions)
- Don't create duplicate pages with the same slug
- Don't remove the last block from a page
