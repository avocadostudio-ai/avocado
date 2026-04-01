import type { JSX } from "react"
import styles from "./styles.module.css"

export function PricingTable(props: Record<string, unknown>): JSX.Element {
  const title = String(props.title ?? "")
  const footerNote = String(props.footerNote ?? "")
  const columns = Array.isArray(props.columns) ? props.columns : []

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
          {columns.map((raw, idx) => {
            const col = (raw ?? {}) as Record<string, unknown>
            const duration = String(col.duration ?? "")
            const category = String(col.category ?? "")
            const days = String(col.days ?? "")
            const price = String(col.price ?? "")
            const unit = String(col.unit ?? "")
            const inclusions = Array.isArray(col.inclusions) ? col.inclusions : []

            return (
              <div key={idx} className={styles.column}>
                <p
                  className={styles.duration}
                  data-editable-target={`columns[${idx}].duration`}
                  data-editable-target-label={`columns[${idx}].duration`}
                  data-editable-label={`columns[${idx}].duration`}
                >
                  {duration}
                </p>
                <p
                  className={styles.category}
                  data-editable-target={`columns[${idx}].category`}
                  data-editable-target-label={`columns[${idx}].category`}
                  data-editable-label={`columns[${idx}].category`}
                >
                  {category}
                </p>
                <p
                  className={styles.days}
                  data-editable-target={`columns[${idx}].days`}
                  data-editable-target-label={`columns[${idx}].days`}
                  data-editable-label={`columns[${idx}].days`}
                >
                  {days}
                </p>

                <hr className={styles.priceDivider} />

                <p
                  className={styles.price}
                  data-editable-target={`columns[${idx}].price`}
                  data-editable-target-label={`columns[${idx}].price`}
                  data-editable-label={`columns[${idx}].price`}
                >
                  {price}
                </p>
                <p
                  className={styles.unit}
                  data-editable-target={`columns[${idx}].unit`}
                  data-editable-target-label={`columns[${idx}].unit`}
                  data-editable-label={`columns[${idx}].unit`}
                >
                  {unit}
                </p>

                {inclusions.length > 0 && (
                  <ul className={styles.inclusions}>
                    {inclusions.map((item, iIdx) => (
                      <li
                        key={iIdx}
                        className={styles.inclusionItem}
                        data-editable-target={`columns[${idx}].inclusions[${iIdx}]`}
                        data-editable-target-label={`columns[${idx}].inclusions[${iIdx}]`}
                        data-editable-label={`columns[${idx}].inclusions[${iIdx}]`}
                      >
                        {String(item ?? "")}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>

        {footerNote.length > 0 && (
          <p
            className={styles.footerNote}
            data-editable-target="footerNote"
            data-editable-target-label="footerNote"
            data-editable-label="footerNote"
          >
            {footerNote}
          </p>
        )}
      </div>
    </section>
  )
}
