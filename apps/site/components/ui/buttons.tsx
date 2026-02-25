import type { AnchorHTMLAttributes } from "react"

type BtnProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
}

export function PrimaryButton({ href, children, className, ...rest }: BtnProps) {
  return (
    <a href={href} className={["btn-primary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

export function SecondaryButton({ href, children, className, ...rest }: BtnProps) {
  return (
    <a href={href} className={["btn-secondary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}
