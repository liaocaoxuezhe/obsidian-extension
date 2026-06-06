import { useEffect, useRef, useState } from "react"

export function useScrollReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [isRevealed, setIsRevealed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsRevealed(true)
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.1 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { ref, isRevealed }
}

export function useStagger(index: number, baseDelay: number = 0.1) {
  return { animationDelay: `${index * baseDelay}s` }
}
