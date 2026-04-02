import type { JSX } from "react"
import styles from "./styles.module.css"

export function PricingTable(props: Record<string, unknown>): JSX.Element {
  const title = String(props.title ?? "")
  const footnote = String(props.footnote ?? "")
  const tiers = Array.isArray(props.tiers) ? props.tiers : []

  return (
    <section className={styles.section}>
      <div className={styles.inner}>
        {title.length > 0 && (
          <h2
            className={styles.heading}
            data-editable-target="title"
            data-editable-target-label="title"
            data-editable-label="title"
          >
            {title}
          </h2>
        )}

        <div className={styles.grid}>
          {tiers.map((raw, idx) => {
            const tier = (raw ?? {}) as Record<string, unknown>
            const duration = String(tier.duration ?? "")
            const days = String(tier.days ?? "")
            const price = String(tier.price ?? "")
            const isSpecial = tier.isSpecial === true
            const features = Array.isArray(tier.features) ? tier.features : []

            return (
              <div key={idx} className={`${styles.card} ${isSpecial ? styles.cardSpecial : ""}`}>
                {isSpecial && (
                  <div className={styles.badge}>SPEZIALPREIS</div>
                )}

                <div className={styles.duration}
                  data-editable-target={`tiers[${idx}].duration`}
                  data-editable-target-label={`tiers[${idx}].duration`}
                  data-editable-label={`tiers[${idx}].duration`}
                >
                  {duration}
                </div>

                <div className={styles.days}
                  data-editable-target={`tiers[${idx}].days`}
                  data-editable-target-label={`tiers[${idx}].days`}
                  data-editable-label={`tiers[${idx}].days`}
                >
                  {days}
                </div>

                <div className={styles.price}
                  data-editable-target={`tiers[${idx}].price`}
                  data-editable-target-label={`tiers[${idx}].price`}
                  data-editable-label={`tiers[${idx}].price`}
                >
                  {price}
                </div>

                <ul className={styles.features}>
                  {features.map((feature, fIdx) => (
                    <li key={fIdx} className={styles.feature}>
                      <span className={styles.featureCheck} aria-hidden="true">✓</span>
                      <span>{String(feature ?? "")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        {footnote.length > 0 && (
          <p
            className={styles.footnote}
            data-editable-target="footnote"
            data-editable-target-label="footnote"
            data-editable-label="footnote"
          >
            {footnote}
          </p>
        )}
      </div>
    </section>
  )
}
