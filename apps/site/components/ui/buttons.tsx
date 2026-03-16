import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react"

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

export function PrimaryLink({ href, children, className, ...rest }: LinkProps) {
  return (
    <a href={href} className={["btn-primary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

export function SecondaryLink({ href, children, className, ...rest }: LinkProps) {
  return (
    <a href={href} className={["btn-secondary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

export function PrimaryButton({ children, className, ...rest }: ButtonProps) {
  return (
    <button type="button" className={["btn-primary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </button>
  )
}

export function SecondaryButton({ children, className, ...rest }: ButtonProps) {
  return (
    <button type="button" className={["btn-secondary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </button>
  )
}
