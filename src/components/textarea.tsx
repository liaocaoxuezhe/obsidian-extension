import * as React from "react"

import {cn} from "../util/cn-helper";

const Textarea = React.forwardRef<
    HTMLTextAreaElement,
    React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
    return (
        <textarea
            className={cn(
                "flex w-full rounded-md border border-[#e5e5e5] bg-white px-3 py-2 text-base ring-offset-white placeholder:text-[#444444] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#0a0a0a] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
                className
            )}
            ref={ref}
            {...props}
        />
    )
})
Textarea.displayName = "Textarea"

export { Textarea }
