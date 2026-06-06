import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import {cn} from "../util/cn-helper";

const buttonVariants = cva(
    "inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#0a0a0a] disabled:pointer-events-none disabled:opacity-50 hover:scale-[1.02]",
    {
        variants: {
            variant: {
                default: "bg-[#0a0a0a] text-white hover:bg-[#333333]",
                destructive:
                    "bg-[#e74c3c] text-white hover:bg-[#c0392b]",
                outline:
                    "border border-[#0a0a0a] bg-transparent hover:bg-[#f5f5f5] hover:text-[#0a0a0a]",
                secondary:
                    "bg-[#f5f5f5] text-[#0a0a0a] hover:bg-[#e5e5e5]",
                ghost: "hover:bg-[#f5f5f5] hover:text-[#0a0a0a]",
                link: "text-[#0a0a0a] underline-offset-4 hover:underline",
            },
            size: {
                default: "h-10 px-6 py-2",
                sm: "h-9 rounded-full px-4",
                lg: "h-11 rounded-full px-8",
                icon: "h-10 w-10",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button"
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        )
    }
)
Button.displayName = "Button"

export { Button, buttonVariants }
