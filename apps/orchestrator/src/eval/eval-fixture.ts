// ---------------------------------------------------------------------------
// RICH_PAGES fixture — 8 pages, ~40 blocks
// Single source of truth. Imported by both eval runner and e2e-editing.test.ts.
// ---------------------------------------------------------------------------

import type { PageDoc } from "@ai-site-editor/shared"

export const RICH_PAGES: PageDoc[] = [
  {
    id: "p_home", slug: "/", title: "Home", updatedAt: "2026-03-03T22:46:56.033Z",
    blocks: [
      { id: "b_hero_home_rich", type: "Hero", props: { heading: "Discover the Magic of Avocados", subheading: "Experience the vibrant taste and health benefits of our avocados — a delightful addition to any dish.", ctaText: "Get Started", ctaHref: "/", imageUrl: "/hero-generated.svg", imageAlt: "Avocados in natural light" } },
      { id: "b_cardgrid_home", type: "CardGrid", props: { title: "Sustainable Avocado Adventures", cards: [{ title: "Avocado Culinary Delights", description: "Uncover new culinary uses for avocados.", ctaText: "Try Now", ctaHref: "/avocado-culinary" }, { title: "Avocado Wellness", description: "Explore the wellness benefits of avocados.", ctaText: "Discover", ctaHref: "/avocado-wellness" }, { title: "Avocado Sustainability", description: "Learn about sustainable avocado farming practices.", ctaText: "Learn More", ctaHref: "/avocado-sustainability" }] } },
      { id: "b_featuregrid_home", type: "FeatureGrid", props: { title: "Why Readers Love Avocados", features: [{ title: "Nutrition", description: "Packed with healthy fats, fiber, and vitamins." }, { title: "Versatility", description: "Perfect for toast, salads, and smoothies." }, { title: "Flavor", description: "Creamy texture with a rich, satisfying taste." }] } },
      { id: "b_testimonials_home", type: "Testimonials", props: { title: "Testimonials from Avocado Enthusiasts", items: [{ quote: "Avocados are a superfood that never fails to impress!", author: "Emily Avocado" }, { quote: "Avocados are my culinary secret weapon.", author: "Michael Green" }, { quote: "The best avocados I've ever tasted!", author: "Sarah Chef" }] } },
      { id: "b_richtext_home", type: "RichText", props: { title: "Discover the Magic of Avocados", body: "# Nutritional Benefits of Avocados\n\nAvocados are not only delicious but also packed with essential nutrients." } },
      { id: "b_stats_home", type: "Stats", props: { title: "Avocado Impact by the Numbers", stats: [{ value: "10K+", label: "Happy Readers" }, { value: "500+", label: "Recipes Shared" }, { value: "99%", label: "Nutrition Rating" }] } },
      { id: "b_cta_home", type: "CTA", props: { title: "Join the Avocado Revolution", description: "Experience the richness and health benefits of our premium avocados.", ctaText: "Get Started", ctaHref: "/signup" } },
      { id: "b_richtext_home_2", type: "RichText", props: { title: "", body: "# From Farm to Table\n\nAt Avocado Magic we believe that great food starts with great ingredients." } },
    ],
  },
  {
    id: "p_bananas", slug: "/bananas", title: "Bananas", updatedAt: "2026-02-26T23:55:19.815Z",
    blocks: [
      { id: "b_hero_bananas", type: "Hero", props: { heading: "Bananas: Nature's Energy Booster", subheading: "Explore the benefits and versatility of bananas.", ctaText: "Learn More", ctaHref: "/banana-benefits", imageUrl: "/hero-generated.svg", imageAlt: "Bananas" } },
      { id: "b_richtext_bananas", type: "RichText", props: { title: "", body: "**Bananas** are not only a great source of energy but also packed with essential nutrients." } },
      { id: "b_cardgrid_bananas", type: "CardGrid", props: { title: "Explore More Banana Benefits", cards: [{ title: "Nutritional Facts", description: "Discover the essential nutrients packed in bananas.", ctaText: "Learn More", ctaHref: "/banana-nutrition" }, { title: "Banana Recipes", description: "Try delicious banana recipes for every meal.", ctaText: "Get Recipes", ctaHref: "/banana-recipes" }, { title: "Health Benefits", description: "Understand how bananas contribute to your health.", ctaText: "Read More", ctaHref: "/banana-health" }] } },
    ],
  },
  {
    id: "p_strawberries", slug: "/strawberries", title: "Strawberries", updatedAt: "2026-02-26T20:02:58.431Z",
    blocks: [
      { id: "b_hero_strawberries", type: "Hero", props: { heading: "Discover the Sweetness of Strawberries", subheading: "Nature's candy packed with nutrients.", ctaText: "Learn More", ctaHref: "/strawberries", imageUrl: "/hero-generated.svg", imageAlt: "Fresh strawberries" } },
      { id: "b_richtext_strawberries", type: "RichText", props: { title: "Why Strawberries?", body: "Strawberries are not only delicious but also packed with vitamins, fiber, and high levels of antioxidants." } },
      { id: "b_featuregrid_strawberries", type: "FeatureGrid", props: { title: "Health Benefits", features: [{ title: "Rich in Nutrients", description: "Strawberries are an excellent source of vitamin C and manganese." }, { title: "Antioxidant Powerhouse", description: "These berries are loaded with antioxidants and plant compounds." }] } },
      { id: "b_faq_strawberries", type: "FAQAccordion", props: { title: "Frequently Asked Questions", items: [{ q: "What are the health benefits of strawberries?", a: "Strawberries are rich in vitamins, fiber, and antioxidants." }, { q: "How should I store strawberries?", a: "Store strawberries in the refrigerator and wash them just before eating." }, { q: "Can strawberries be frozen?", a: "Yes, strawberries can be frozen. Wash and dry them thoroughly first." }] } },
      { id: "b_cta_strawberries", type: "CTA", props: { title: "Enjoy Strawberries Today", description: "Add strawberries to your diet and enjoy their sweet taste and health benefits.", ctaText: "Find Recipes", ctaHref: "/strawberries-recipes" } },
    ],
  },
  {
    id: "p_oranges", slug: "/oranges", title: "Oranges", updatedAt: "2026-02-26T22:40:07.960Z",
    blocks: [
      { id: "b_hero_oranges", type: "Hero", props: { heading: "Citrus Bliss", subheading: "Discover the vibrant world of citrus fruits.", ctaText: "Learn More", ctaHref: "/oranges", imageUrl: "/hero-generated.svg", imageAlt: "Oranges" } },
      { id: "b_richtext_oranges", type: "RichText", props: { title: "The Wonders of Oranges", body: "**Oranges** are among the most beloved fruits globally, cherished for their delicious taste and nutritional benefits." } },
    ],
  },
  {
    id: "p_olives", slug: "/olives", title: "Olives", updatedAt: "2026-02-26T23:56:20.128Z",
    blocks: [
      { id: "b_hero_olives", type: "Hero", props: { heading: "Finest Olive Oils", subheading: "From sun-soaked Mediterranean groves to small artisan producers.", ctaText: "Shop the Collection", ctaHref: "/shop", imageUrl: "/hero-generated.svg", imageAlt: "Olives" } },
      { id: "b_cardgrid_olives", type: "CardGrid", props: { title: "Key Health Benefits of Olive Oil", cards: [{ title: "Rich in Healthy Fats", description: "Olive oil is high in oleic acid, a monounsaturated fat.", ctaText: "Learn More", ctaHref: "/health-benefits" }, { title: "High in Antioxidants", description: "Contains large amounts of antioxidants.", ctaText: "Discover More", ctaHref: "/antioxidants" }, { title: "Supports Heart Health", description: "Regular consumption linked to reduced risk of heart disease.", ctaText: "Find Out More", ctaHref: "/heart-health" }] } },
      { id: "b_richtext_olives", type: "RichText", props: { title: "", body: "Olive oil is a staple in many kitchens worldwide." } },
    ],
  },
  {
    id: "p_cherries", slug: "/cherries", title: "Cherries", updatedAt: "2026-02-27T23:24:35.403Z",
    blocks: [
      { id: "b_hero_cherries", type: "Hero", props: { heading: "Discover the Delight of Cherries", subheading: "Explore the sweet and tart flavors of our premium cherries.", ctaText: "Learn More", ctaHref: "/cherries", imageUrl: "/hero-generated.svg", imageAlt: "Cherries" } },
      { id: "b_richtext_cherries_1", type: "RichText", props: { title: "Benefits of Cherries", body: "Cherries are not only delicious but also packed with nutrients and antioxidants." } },
      { id: "b_faq_cherries", type: "FAQAccordion", props: { title: "Frequently Asked Questions about Cherries", items: [{ q: "What are the health benefits of cherries?", a: "Cherries are rich in antioxidants, vitamin C, potassium, and fiber." }, { q: "Can cherries help improve sleep?", a: "Yes, cherries contain natural melatonin which can help regulate sleep." }, { q: "Are cherries good for muscle recovery?", a: "Cherries have anti-inflammatory properties that can aid in muscle recovery." }] } },
      { id: "b_richtext_cherries_2", type: "RichText", props: { title: "Vitamins in Cherries", body: "Cherries are a great source of essential vitamins including vitamin C and vitamin A." } },
    ],
  },
  {
    id: "p_about_us", slug: "/about-us", title: "About Us", updatedAt: "2026-02-26T20:01:21.390Z",
    blocks: [
      { id: "b_hero_about", type: "Hero", props: { heading: "Welcome to Our Company", subheading: "Celebrating 100 years of innovation and excellence", ctaText: "Discover Our Legacy", ctaHref: "/about-us", imageUrl: "/hero-generated.svg", imageAlt: "Welcome to Our Company" } },
      { id: "b_cardgrid_about", type: "CardGrid", props: { title: "Our Values", cards: [{ title: "Quality", description: "We source only the finest ingredients.", ctaText: "Learn More", ctaHref: "/quality" }, { title: "Sustainability", description: "Committed to sustainable farming.", ctaText: "Learn More", ctaHref: "/sustainability" }, { title: "Community", description: "Supporting local communities worldwide.", ctaText: "Learn More", ctaHref: "/community" }] } },
      { id: "b_richtext_about", type: "RichText", props: { title: "", body: "**Our journey with avocados** began over a century ago." } },
      { id: "b_faq_about", type: "FAQAccordion", props: { title: "Frequently Asked Questions", items: [{ q: "Where are your avocados grown?", a: "Our avocados are sourced from sustainable farms in Mexico, California, and Peru." }, { q: "Do you offer wholesale?", a: "Yes, we offer wholesale pricing for bulk orders." }, { q: "How can I become a supplier?", a: "Please contact our partnerships team at partners@avocadomagic.com." }] } },
    ],
  },
  {
    id: "p_about_lemons", slug: "/about-lemons", title: "About Lemons", updatedAt: "2026-02-27T23:25:08.636Z",
    blocks: [
      { id: "b_hero_lemons", type: "Hero", props: { heading: "Explore the Benefits of Lemons", subheading: "Discover Health and Culinary Uses", ctaText: "Find Out More", ctaHref: "/about-lemons", imageUrl: "/hero-generated.svg", imageAlt: "Lemons" } },
      { id: "b_richtext_lemons", type: "RichText", props: { title: "The Zesty World of Lemons", body: "When life gives you lemons, make lemonade! Lemons are not just a fruit; they are a versatile powerhouse." } },
      { id: "b_cardgrid_lemons", type: "CardGrid", props: { title: "Interesting Lemon Facts", cards: [{ title: "Rich in Vitamin C", description: "Lemons are one of the best sources of vitamin C.", ctaText: "Learn More", ctaHref: "/lemon-nutrition" }, { title: "Natural Cleaner", description: "Lemon juice is a powerful natural cleaning agent.", ctaText: "Discover", ctaHref: "/lemon-uses" }, { title: "Culinary Uses", description: "From dressings to desserts, lemons enhance any recipe.", ctaText: "Get Recipes", ctaHref: "/lemon-recipes" }] } },
    ],
  },
]
