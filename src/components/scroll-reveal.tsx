import * as React from "react"
import { useEffect, useRef } from "react"

interface ScrollRevealProps {
  children: React.ReactNode
  className?: string
  delay?: number
}

export const ScrollReveal: React.FC<ScrollRevealProps> = ({ children, className, delay = 0 }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setTimeout(() => {
              entry.target.classList.add("revealed")
            }, delay * 1000)
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.1 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [delay])

  return (
    <div ref={ref} className={`scroll-reveal ${className || ""}`}>
      {children}
    </div>
  )
}
