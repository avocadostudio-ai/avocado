// Side-effect registration of template-specific custom blocks.
// Imported from app/layout.tsx so it runs in every server/client context
// before any route handler, renderer, or manifest builder needs the registry.

import { registerCustomRenderer } from "@avocadostudio-ai/blocks"
import "./schemas"
import {
  CtfHeroBannerRenderer,
  CtfDuplexRenderer,
  CtfInfoBlockRenderer,
  CtfCtaRenderer,
  CtfQuoteRenderer,
  CtfTextBlockRenderer,
  CtfPersonRenderer,
  CtfProductRenderer,
  CtfBusinessInfoRenderer,
  CtfProductTableRenderer,
  CtfFooterRenderer,
} from "./renderers"

registerCustomRenderer("CtfHeroBanner", CtfHeroBannerRenderer)
registerCustomRenderer("CtfDuplex", CtfDuplexRenderer)
registerCustomRenderer("CtfInfoBlock", CtfInfoBlockRenderer)
registerCustomRenderer("CtfCta", CtfCtaRenderer)
registerCustomRenderer("CtfQuote", CtfQuoteRenderer)
registerCustomRenderer("CtfTextBlock", CtfTextBlockRenderer)
registerCustomRenderer("CtfPerson", CtfPersonRenderer)
registerCustomRenderer("CtfProduct", CtfProductRenderer)
registerCustomRenderer("CtfBusinessInfo", CtfBusinessInfoRenderer)
registerCustomRenderer("CtfProductTable", CtfProductTableRenderer)
registerCustomRenderer("CtfFooter", CtfFooterRenderer)
