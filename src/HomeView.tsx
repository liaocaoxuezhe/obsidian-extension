import { useEffect, useState } from "react"
import { SmartConnection } from "./SmartConnection";
import { Badge } from "./components/badge";
import { Button } from "./components/button";
import { appVersion, icon } from "./model/Consts";

export const HomeView = ({ main }: { main: any }) => {
  const [activeFile, setActiveFile] = useState(() => {
    return main.app.workspace.getActiveFile()
  })

  useEffect(() => {
    main.registerEvent(main.app.workspace.on('file-open', (file: any) => {
      setActiveFile(file)
    }))
  }, []);

  return (
    <div className="px-2 pt-3 animate-fade-in-up">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-serif text-lg font-bold text-[#0a0a0a] flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 100 100" className="inline-block" dangerouslySetInnerHTML={{ __html: icon }} />
            <span>· Analogy</span>
          </span>
        </div>
        <Badge variant="secondary" className="text-xs text-[#444444] bg-[#f5f5f5]">
          v{appVersion}
        </Badge>
      </div>
      <div>
        <SmartConnection activeFile={activeFile} />
      </div>
    </div>
  );
};
