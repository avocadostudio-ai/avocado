/**
 * Server-side locale strings for deterministic planner responses.
 * Covers summary_for_user messages that bypass the LLM.
 */

export type ServerLocale = "en" | "de"

function resolveLocale(locale?: string): ServerLocale {
  if (locale === "de") return "de"
  return "en"
}

const en = {
    "rename.needsPath": "Please provide the target page path, for example: rename page from /old to /new.",
    "rename.done": "Renamed page path from {{from}} to {{to}}.",
    "delete.homeBlocked": "The home page cannot be deleted. Navigate to a different page first, or specify which page to delete (e.g. \"delete /about\").",
    "delete.done": "Deleted page {{slug}}.",
    "move.notFound": "I could not find page {{slug}}.",
    "move.homeFixed": "Home page (/) is fixed at the first position in navigation.",
    "move.specifyWhere": "Specify where to place the page (first/last/before/after).",
    "move.anchorNotFound": "I could not find anchor page {{slug}}.",
    "move.done": "Moved **{{slug}}** {{direction}}.",
    "audience.done": "Tailored this page for {{audience}}.",
    "reorder.specify": "I can reorder sections if needed, but please specify what should move (for example: move FAQ below Testimonials).",
    "hero.secondaryCta": "Added a secondary CTA button to the selected Hero.",
    "update.done": "Updated {{type}}.",
    "update.specify": "Please specify the section and exact change you want.",
    "update.needsBlock": "I need to know which block to update.",
    "update.invalidFields": "Please specify at least one valid field for {{type}}.",
    "remove.allAlready": "All blocks are already {{type}} — nothing to remove.",
    "remove.keptOnly": "Removed all blocks except {{type}}.",
    "remove.needsBlock": "I need to know which block to remove.",
    "remove.specifyItem": "Please specify which item to remove (e.g., \"the first question\", \"the last item\").",
    "remove.outOfRange": "There are only {{count}} items in {{type}} — cannot remove item {{index}}.",
    "remove.itemDone": "Removed an item from {{type}}.",
    "remove.done": "Removed {{type}}.",
    "move.needsBlock": "I need to know which block to move.",
    "move.anchorBlockNotFound": "I could not find the anchor block to move after.",
    "move.anchorBlockBeforeNotFound": "I could not find the anchor block to move before.",
    "move.specifyDirection": "Please specify where to move the block (top, bottom, before, after).",
    "move.blockDone": "Moved {{type}}.",
    "add.multiple": "Added {{types}}.",
    "add.heroImage": "Updated the hero image.",
    "add.specifyType": "Please specify which block type to add ({{types}}).",
    "add.itemDone": "Added an item to {{type}}.",
    "add.anchorAfterNotFound": "I could not find the anchor block to place this after.",
    "add.anchorBeforeNotFound": "I could not find the anchor block to place this before.",
    "add.done": "Added {{type}}.",
    "duplicate.done": "Duplicated {{type}}.",
    "duplicate.pageDone": "Duplicated page {{from}} as {{to}}.",
} as const

type ServerStringKey = keyof typeof en
const strings: Record<ServerLocale, Record<ServerStringKey, string>> = {
  en,
  de: {
    "rename.needsPath": "Bitte gib den Zielpfad an, zum Beispiel: Seite umbenennen von /alt nach /neu.",
    "rename.done": "Seitenpfad von {{from}} nach {{to}} umbenannt.",
    "delete.homeBlocked": "Die Startseite kann nicht gel\u00F6scht werden. Navigiere zuerst zu einer anderen Seite oder gib an, welche Seite gel\u00F6scht werden soll (z.\u00A0B. \"/about l\u00F6schen\").",
    "delete.done": "Seite {{slug}} gelöscht.",
    "move.notFound": "Seite {{slug}} nicht gefunden.",
    "move.homeFixed": "Die Startseite (/) ist fest an erster Stelle in der Navigation.",
    "move.specifyWhere": "Gib an, wohin die Seite verschoben werden soll (erste/letzte/vor/nach).",
    "move.anchorNotFound": "Ankerseite {{slug}} nicht gefunden.",
    "move.done": "**{{slug}}** {{direction}} verschoben.",
    "audience.done": "Diese Seite wurde für {{audience}} angepasst.",
    "reorder.specify": "Ich kann Bereiche umordnen, aber bitte gib an, was verschoben werden soll (z.\u00A0B.: FAQ unter Testimonials verschieben).",
    "hero.secondaryCta": "Sekundären CTA-Button zum ausgewählten Hero hinzugefügt.",
    "update.done": "{{type}} aktualisiert.",
    "update.specify": "Bitte gib den Bereich und die gewünschte Änderung an.",
    "update.needsBlock": "Ich muss wissen, welcher Block aktualisiert werden soll.",
    "update.invalidFields": "Bitte gib mindestens ein gültiges Feld für {{type}} an.",
    "remove.allAlready": "Alle Blöcke sind bereits {{type}} — nichts zu entfernen.",
    "remove.keptOnly": "Alle Blöcke außer {{type}} entfernt.",
    "remove.needsBlock": "Ich muss wissen, welcher Block entfernt werden soll.",
    "remove.specifyItem": "Bitte gib an, welches Element entfernt werden soll (z.\u00A0B. 'die erste Frage', 'das letzte Element').",
    "remove.outOfRange": "Es gibt nur {{count}} Elemente in {{type}} — Element {{index}} kann nicht entfernt werden.",
    "remove.itemDone": "Element aus {{type}} entfernt.",
    "remove.done": "{{type}} entfernt.",
    "move.needsBlock": "Ich muss wissen, welcher Block verschoben werden soll.",
    "move.anchorBlockNotFound": "Ankerblock zum Verschieben nicht gefunden.",
    "move.anchorBlockBeforeNotFound": "Ankerblock zum Davor-Platzieren nicht gefunden.",
    "move.specifyDirection": "Bitte gib an, wohin der Block verschoben werden soll (oben, unten, vor, nach).",
    "move.blockDone": "{{type}} verschoben.",
    "add.multiple": "{{types}} hinzugefügt.",
    "add.heroImage": "Hero-Bild aktualisiert.",
    "add.specifyType": "Bitte gib den Blocktyp an, der hinzugefügt werden soll ({{types}}).",
    "add.itemDone": "Element zu {{type}} hinzugefügt.",
    "add.anchorAfterNotFound": "Ankerblock zum Danach-Platzieren nicht gefunden.",
    "add.anchorBeforeNotFound": "Ankerblock zum Davor-Platzieren nicht gefunden.",
    "add.done": "{{type}} hinzugefügt.",
    "duplicate.done": "{{type}} dupliziert.",
    "duplicate.pageDone": "Seite {{from}} als {{to}} dupliziert.",
  },
}

export function st(locale: string | undefined, key: ServerStringKey, vars?: Record<string, string | number>): string {
  const l = resolveLocale(locale)
  let str = strings[l][key] ?? strings.en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{{${k}}}`, String(v))
    }
  }
  return str
}
