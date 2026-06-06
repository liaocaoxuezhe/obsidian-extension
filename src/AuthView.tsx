import { useState } from "react";
import { Loader } from "lucide-react";
import * as React from "react";
import { Button } from "./components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/dialog"
import { PageAuthCheckboxList } from "./PageAuthView";

// @ts-ignore
export const AuthView = ({ setIsLoginFinished, setUser }) => {
  const [open, setOpen] = React.useState(false);
  const [isIndexing, setIsIndexing] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center py-12 animate-fade-in-up">
      <div className="text-center mb-6">
        <h2 className="font-serif text-2xl font-bold text-[#0a0a0a] mb-2">
          <span className="text-[#e74c3c]">A</span>· Analogy
        </h2>
        <p className="text-sm text-[#444444]">
          Local semantic search for your Obsidian vault.
        </p>
      </div>
      <Dialog onOpenChange={(isOpen) => { setOpen(isOpen) }}>
        <DialogTrigger asChild>
          <Button className="px-8">
            Build Local Index
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-[40rem] w-2/3 gap-0.5 block p-4" style={{ height: "600px" }}>
          <DialogHeader className="space-y-1.5">
            <DialogTitle className="" style={{ margin: "0", lineHeight: "1.75rem" }}>
              Index Manager
            </DialogTitle>
            <DialogDescription className="" style={{ margin: "0" }}>
              Select notes to build local vector index.
            </DialogDescription>
          </DialogHeader>
          <div className="">
            {open ? (
              <PageAuthCheckboxList
                setUser={setUser}
                setLoginStatus={null}
                setIsLoginFinished={setIsLoginFinished}
              />
            ) : ""}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
