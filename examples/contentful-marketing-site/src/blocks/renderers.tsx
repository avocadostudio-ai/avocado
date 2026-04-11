"use client"
import { Box, Button, Container, Grid2 as Grid, Paper, Stack, Typography } from "@mui/material"
import SearchIcon from "@mui/icons-material/Search"
import HelpOutlineIcon from "@mui/icons-material/HelpOutline"
import ArticleIcon from "@mui/icons-material/Article"
import { getColorConfigFromPalette } from "../theme"

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function asList<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

// ---------------------------------------------------------------------------
// CtfHeroBanner
// ---------------------------------------------------------------------------
export function CtfHeroBannerRenderer(props: Record<string, unknown>) {
  const headline = asString(props.headline, "Untitled hero")
  const bodyText = asString(props.bodyText)
  const ctaText = asString(props.ctaText)
  const targetPage = asString(props.targetPage, "#")
  const imageUrl = asString(props.imageUrl)
  const heroSize = asString(props.heroSize, "full_screen")
  const imageStyle = asString(props.imageStyle, "full")
  const colorPalette = asString(props.colorPalette)
  const color = getColorConfigFromPalette(colorPalette)

  const isFullScreen = heroSize === "full_screen"
  const showPartial = imageStyle === "partial" && imageUrl

  return (
    <Box
      sx={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        minHeight: isFullScreen ? { xs: "60vh", md: "80vh" } : { xs: "40vh", md: "50vh" },
        backgroundColor: color.backgroundColor,
        backgroundImage: imageStyle === "full" && imageUrl ? `url(${imageUrl})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {showPartial && (
        <Box
          aria-hidden
          sx={{
            display: { xs: "none", md: "block" },
            position: "absolute",
            top: 0,
            right: 0,
            width: "50%",
            height: "100%",
            backgroundImage: `url(${imageUrl})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
      )}
      <Container sx={{ position: "relative", py: { xs: 12, md: 20 } }}>
        <Typography variant="h1" sx={{ color: color.headlineColor, maxWidth: "44rem", fontWeight: 800 }}>
          {headline}
        </Typography>
        {bodyText && (
          <Typography sx={{ mt: 4, color: color.textColor, maxWidth: "46rem", fontSize: "1.8rem", lineHeight: 1.6 }}>
            {bodyText}
          </Typography>
        )}
        {ctaText && (
          <Box sx={{ mt: 6 }}>
            <Button variant="contained" color={color.buttonColor} href={targetPage}>
              {ctaText}
            </Button>
          </Box>
        )}
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfDuplex
// ---------------------------------------------------------------------------
export function CtfDuplexRenderer(props: Record<string, unknown>) {
  const headline = asString(props.headline, "Untitled")
  const bodyText = asString(props.bodyText)
  const ctaText = asString(props.ctaText)
  const targetPage = asString(props.targetPage, "#")
  const imageUrl = asString(props.imageUrl)
  const layout = asString(props.containerLayout, "image_left")
  const colorPalette = asString(props.colorPalette)
  const color = getColorConfigFromPalette(colorPalette)
  const reverse = layout === "image_right"

  return (
    <Box sx={{ backgroundColor: color.backgroundColor, py: { xs: 10, md: 16 } }}>
      <Container>
        <Grid container spacing={6} alignItems="center" direction={reverse ? "row-reverse" : "row"}>
          <Grid size={{ xs: 12, md: 6 }}>
            {imageUrl ? (
              <Box
                component="img"
                src={imageUrl}
                alt=""
                sx={{ width: "100%", height: "auto", borderRadius: 2, display: "block" }}
              />
            ) : (
              <Box sx={{ width: "100%", aspectRatio: "4/3", backgroundColor: "#00000010", borderRadius: 2 }} />
            )}
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Typography variant="h2" sx={{ color: color.headlineColor }}>
              {headline}
            </Typography>
            {bodyText && (
              <Typography sx={{ mt: 4, color: color.textColor, fontSize: "1.8rem", lineHeight: 1.6 }}>
                {bodyText}
              </Typography>
            )}
            {ctaText && (
              <Box sx={{ mt: 6 }}>
                <Button variant="contained" color={color.buttonColor} href={targetPage}>
                  {ctaText}
                </Button>
              </Box>
            )}
          </Grid>
        </Grid>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfInfoBlock
// ---------------------------------------------------------------------------
function IconForName({ name }: { name: string }) {
  if (name === "search") return <SearchIcon sx={{ fontSize: "6rem" }} />
  if (name === "help") return <HelpOutlineIcon sx={{ fontSize: "6rem" }} />
  return <ArticleIcon sx={{ fontSize: "6rem" }} />
}

export function CtfInfoBlockRenderer(props: Record<string, unknown>) {
  const headline = asString(props.headline, "Info")
  const subline = asString(props.subline)
  const body = asString(props.body)
  const icon = asString(props.icon, "markdown")
  const colorPalette = asString(props.colorPalette)
  const color = getColorConfigFromPalette(colorPalette)

  return (
    <Box sx={{ backgroundColor: color.backgroundColor, py: { xs: 10, md: 16 } }}>
      <Container maxWidth="md">
        <Stack alignItems="center" textAlign="center" spacing={4}>
          <Box sx={{ color: color.headlineColor }}>
            <IconForName name={icon} />
          </Box>
          <Typography variant="h2" sx={{ color: color.headlineColor }}>
            {headline}
          </Typography>
          {subline && (
            <Typography variant="h3" sx={{ color: color.textColor }}>
              {subline}
            </Typography>
          )}
          {body && (
            <Typography sx={{ color: color.textColor, fontSize: "1.8rem", lineHeight: 1.6 }}>
              {body}
            </Typography>
          )}
        </Stack>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfCta
// ---------------------------------------------------------------------------
export function CtfCtaRenderer(props: Record<string, unknown>) {
  const headline = asString(props.headline, "Ready to start?")
  const subline = asString(props.subline)
  const ctaText = asString(props.ctaText, "Learn more")
  const targetPage = asString(props.targetPage, "#")
  const imageUrl = asString(props.imageUrl)
  const colorPalette = asString(props.colorPalette)
  const color = getColorConfigFromPalette(colorPalette)

  return (
    <Box
      sx={{
        position: "relative",
        backgroundColor: color.backgroundColor,
        backgroundImage: imageUrl ? `linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.45)), url(${imageUrl})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
        py: { xs: 14, md: 22 },
      }}
    >
      <Container maxWidth="md">
        <Stack alignItems="center" textAlign="center" spacing={4}>
          <Typography variant="h2" sx={{ color: imageUrl ? "#fff" : color.headlineColor }}>
            {headline}
          </Typography>
          {subline && (
            <Typography sx={{ color: imageUrl ? "#eee" : color.textColor, fontSize: "2rem" }}>
              {subline}
            </Typography>
          )}
          <Button variant="contained" color={color.buttonColor} href={targetPage} size="large">
            {ctaText}
          </Button>
        </Stack>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfQuote
// ---------------------------------------------------------------------------
export function CtfQuoteRenderer(props: Record<string, unknown>) {
  const quote = asString(props.quote, "")
  const imageUrl = asString(props.imageUrl)
  const alignment = asString(props.imageAlignment, "left")
  const colorPalette = asString(props.colorPalette)
  const color = getColorConfigFromPalette(colorPalette)
  const reverse = alignment === "right"

  return (
    <Box sx={{ backgroundColor: color.backgroundColor, py: { xs: 10, md: 16 } }}>
      <Container>
        <Grid container spacing={8} alignItems="center" direction={reverse ? "row-reverse" : "row"}>
          {imageUrl && (
            <Grid size={{ xs: 12, md: 5 }}>
              <Box
                component="img"
                src={imageUrl}
                alt=""
                sx={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", borderRadius: 2 }}
              />
            </Grid>
          )}
          <Grid size={{ xs: 12, md: imageUrl ? 7 : 12 }}>
            <Typography
              component="blockquote"
              sx={{
                color: color.headlineColor,
                fontSize: { xs: "2.4rem", md: "3rem" },
                fontWeight: 500,
                fontStyle: "italic",
                lineHeight: 1.3,
                borderLeft: `4px solid ${color.headlineColor}`,
                pl: 4,
              }}
            >
              {quote}
            </Typography>
          </Grid>
        </Grid>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfTextBlock
// ---------------------------------------------------------------------------
export function CtfTextBlockRenderer(props: Record<string, unknown>) {
  const headline = asString(props.headline, "")
  const subline = asString(props.subline)
  const body = asString(props.body)

  return (
    <Box sx={{ py: { xs: 8, md: 12 } }}>
      <Container maxWidth="md">
        {headline && (
          <Typography variant="h2" sx={{ mb: 2 }}>
            {headline}
          </Typography>
        )}
        {subline && (
          <Typography variant="h3" sx={{ mb: 4, color: "text.secondary" }}>
            {subline}
          </Typography>
        )}
        {body && (
          <Typography sx={{ fontSize: "1.8rem", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {body}
          </Typography>
        )}
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfPerson
// ---------------------------------------------------------------------------
export function CtfPersonRenderer(props: Record<string, unknown>) {
  const name = asString(props.name, "Unnamed")
  const avatarUrl = asString(props.avatarUrl)
  const shortBio = asString(props.shortBio)
  const cardStyle = asString(props.cardStyle, "default")
  const isCompact = cardStyle === "compact"

  return (
    <Box sx={{ py: { xs: 6, md: 10 } }}>
      <Container maxWidth={isCompact ? "sm" : "md"}>
        <Paper elevation={0} sx={{ p: { xs: 4, md: 6 }, border: "1px solid #e5e5e5", borderRadius: 2 }}>
          <Stack direction={isCompact ? "row" : { xs: "column", sm: "row" }} spacing={4} alignItems="center">
            {avatarUrl && (
              <Box
                component="img"
                src={avatarUrl}
                alt={name}
                sx={{ width: isCompact ? 80 : 140, height: isCompact ? 80 : 140, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
              />
            )}
            <Box>
              <Typography variant="h3">{name}</Typography>
              {shortBio && (
                <Typography sx={{ mt: 2, color: "text.secondary", fontSize: "1.7rem", lineHeight: 1.6 }}>
                  {shortBio}
                </Typography>
              )}
            </Box>
          </Stack>
        </Paper>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfProduct
// ---------------------------------------------------------------------------
type Feature = { name?: string; longDescription?: string }

export function CtfProductRenderer(props: Record<string, unknown>) {
  const name = asString(props.name, "Product")
  const description = asString(props.description)
  const imageUrl = asString(props.imageUrl)
  const pricing = asString(props.pricing)
  const features = asList<Feature>(props.features)

  return (
    <Box sx={{ py: { xs: 8, md: 12 } }}>
      <Container>
        <Grid container spacing={6}>
          <Grid size={{ xs: 12, md: 6 }}>
            {imageUrl ? (
              <Box
                component="img"
                src={imageUrl}
                alt={name}
                sx={{ width: "100%", borderRadius: 2 }}
              />
            ) : (
              <Box sx={{ width: "100%", aspectRatio: "3/2", backgroundColor: "#00000010", borderRadius: 2 }} />
            )}
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Typography variant="h2">{name}</Typography>
            {pricing && (
              <Typography variant="h3" sx={{ mt: 2, color: "primary.main" }}>
                {pricing}
              </Typography>
            )}
            {description && (
              <Typography sx={{ mt: 3, fontSize: "1.7rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {description}
              </Typography>
            )}
            {features.length > 0 && (
              <Stack sx={{ mt: 4 }} spacing={2}>
                {features.map((f, i) => (
                  <Box key={i}>
                    <Typography sx={{ fontWeight: 600 }}>{f.name}</Typography>
                    {f.longDescription && (
                      <Typography sx={{ color: "text.secondary", fontSize: "1.6rem" }}>
                        {f.longDescription}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </Grid>
        </Grid>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfBusinessInfo
// ---------------------------------------------------------------------------
export function CtfBusinessInfoRenderer(props: Record<string, unknown>) {
  const name = asString(props.name, "Business")
  const shortDescription = asString(props.shortDescription)
  const longDescription = asString(props.longDescription)
  const imageUrl = asString(props.imageUrl)

  return (
    <Box sx={{ py: { xs: 8, md: 12 } }}>
      <Container>
        <Grid container spacing={6} alignItems="center">
          <Grid size={{ xs: 12, md: 5 }}>
            {imageUrl && (
              <Box component="img" src={imageUrl} alt={name} sx={{ width: "100%", borderRadius: 2 }} />
            )}
          </Grid>
          <Grid size={{ xs: 12, md: 7 }}>
            <Typography variant="h2">{name}</Typography>
            {shortDescription && (
              <Typography variant="h3" sx={{ mt: 2, color: "text.secondary" }}>
                {shortDescription}
              </Typography>
            )}
            {longDescription && (
              <Typography sx={{ mt: 3, fontSize: "1.7rem", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                {longDescription}
              </Typography>
            )}
          </Grid>
        </Grid>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfProductTable
// ---------------------------------------------------------------------------
type ProductRow = {
  name?: string
  description?: string
  pricing?: string
  imageUrl?: string
}

export function CtfProductTableRenderer(props: Record<string, unknown>) {
  const headline = asString(props.headline)
  const subline = asString(props.subline)
  const products = asList<ProductRow>(props.products)

  return (
    <Box sx={{ py: { xs: 10, md: 16 } }}>
      <Container>
        {headline && (
          <Typography variant="h2" sx={{ textAlign: "center" }}>
            {headline}
          </Typography>
        )}
        {subline && (
          <Typography sx={{ textAlign: "center", mt: 2, color: "text.secondary", fontSize: "1.8rem" }}>
            {subline}
          </Typography>
        )}
        <Grid container spacing={4} sx={{ mt: 4 }}>
          {products.map((p, i) => (
            <Grid key={i} size={{ xs: 12, sm: 6, md: 4 }}>
              <Paper elevation={0} sx={{ p: 4, height: "100%", border: "1px solid #e5e5e5", borderRadius: 2 }}>
                {p.imageUrl && (
                  <Box component="img" src={p.imageUrl} alt={p.name ?? ""} sx={{ width: "100%", borderRadius: 1, mb: 3 }} />
                )}
                <Typography variant="h3">{p.name}</Typography>
                {p.pricing && (
                  <Typography sx={{ mt: 1, color: "primary.main", fontWeight: 600 }}>{p.pricing}</Typography>
                )}
                {p.description && (
                  <Typography sx={{ mt: 2, color: "text.secondary", fontSize: "1.6rem", whiteSpace: "pre-wrap" }}>
                    {p.description}
                  </Typography>
                )}
              </Paper>
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// CtfFooter (chrome)
// ---------------------------------------------------------------------------
type MenuItem = { label?: string; href?: string }

export function CtfFooterRenderer(props: Record<string, unknown>) {
  const copyright = asString(props.copyright, "")
  const menuItems = asList<MenuItem>(props.menuItems)

  return (
    <Box component="footer" sx={{ borderTop: "1px solid #e5e5e5", py: 8, mt: 8 }}>
      <Container>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", md: "center" }} spacing={4}>
          <Typography sx={{ color: "text.secondary", fontSize: "1.5rem" }}>{copyright}</Typography>
          <Stack direction="row" spacing={4} flexWrap="wrap">
            {menuItems.map((item, i) => (
              <Typography key={i} component="a" href={item.href ?? "#"} sx={{ color: "text.secondary", textDecoration: "none", fontSize: "1.5rem", "&:hover": { color: "text.primary" } }}>
                {item.label}
              </Typography>
            ))}
          </Stack>
        </Stack>
      </Container>
    </Box>
  )
}
