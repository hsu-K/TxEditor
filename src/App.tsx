import { useState } from "react";
import FileExplorer from "./components/FileExplorer";
import Editor from "./components/Editor";
import "./App.css";

interface FileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  content?: string;
  children?: FileItem[];
}

const App = () => {
  const [files, setFiles] = useState<FileItem[]>([
    {
      id: "1",
      name: "README.md",
      type: "file",
      content: "# TX Editor\n\nA simple text editor built with Tauri and React.",
    },
    {
      id: "2",
      name: "src",
      type: "folder",
      children: [
        {
          id: "2-1",
          name: "index.ts",
          type: "file",
          content: "// Main entry point\nconsole.log('Hello World');",
        },
        {
          id: "2-2",
          name: "utils.ts",
          type: "file",
          content: "// Utility functions\n\nexport function sum(a: number, b: number) {\n  return a + b;\n}",
        },
      ],
    },
    {
      id: "3",
      name: "config.json",
      type: "file",
      content: '{\n  "name": "TX Editor",\n  "version": "0.1.0"\n}',
    },
  ]);

  const [selectedFileId, setSelectedFileId] = useState<string>("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [explorerWidth, setExplorerWidth] = useState<number>(250);
  const [isDragging, setIsDragging] = useState(false);

  // 找出文件的所有父文件夾IDs，用於自動展開
  const getParentFolderIds = (fileId: string): string[] => {
    const parentIds: string[] = [];
    while (fileId.length > 1) {
      const parentId = fileId.substring(0, fileId.lastIndexOf("-"));
      if (parentId) {
        parentIds.push(parentId);
        fileId = parentId;
      }
    }
    parentIds.reverse(); // 反轉順序，從根目錄到當前文件
    return parentIds;
  };

  // 利用id來尋找文件，無論它在文件樹的哪個位置
  const getFileById = (id: string): FileItem | undefined => {
    const search = (items: FileItem[]): FileItem | undefined => {
      for (const item of items) {
        if (item.id === id) return item;
        if (item.children) {
          const found = search(item.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return search(files);
  };

  // 當用戶選擇文件時，更新選中的文件ID並確保該文件在打開的標籤中，若tabs中沒有則添加它
  const handleFileSelect = (fileId: string) => {
    const file = getFileById(fileId);
    if (file && file.type === "file") {
      setSelectedFileId(fileId);
      if (!openTabs.includes(fileId)) {
        setOpenTabs([...openTabs, fileId]);
      }
      
      // 自動展開該文件所在的所有父文件夾
      const parentFolders = getParentFolderIds(fileId);
      // console.log("Parent folders to expand:", parentFolders);
      const newExpandedFolders = new Set(expandedFolders);
      parentFolders.forEach((folderId) => newExpandedFolders.add(folderId));
      setExpandedFolders(newExpandedFolders);
    }
  };

  // 當用戶在編輯器中修改文件內容時，更新對應文件的content屬性
  const handleFileChange = (content: string) => {
    const updateFileContent = (items: FileItem[]): FileItem[] => {
      return items.map((item) => {
        if (item.id === selectedFileId) {
          return { ...item, content };
        }
        if (item.children) {
          return { ...item, children: updateFileContent(item.children) };
        }
        return item;
      });
    };

    setFiles(updateFileContent(files));
  };

  // 處理tab被關閉的情況，若正好是當前選中的文件被關閉，則切換到最後一個打開的tab
  // 若所有tabs都關閉，則清空selectedFileId
  const handleCloseTab = (fileId: string) => {
    const newTabs = openTabs.filter((id) => id !== fileId);
    setOpenTabs(newTabs);
    if (selectedFileId === fileId) {
      if (newTabs.length > 0) {
        setSelectedFileId(newTabs[newTabs.length - 1]);
      } else {
        setSelectedFileId(""); // 所有tabs都關閉時，清空selectedFileId
      }
    }
  };

  const selectedFile = getFileById(selectedFileId);

  // 處理分割線拖動
  const handleMouseDown = () => {
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const newWidth = e.clientX;
    const windowWidth = window.innerWidth;
    // const minWidth = windowWidth * 0.15; // 最小 15%
    const maxWidth = windowWidth * 0.8;  // 最大 80%
    if (newWidth > 150 && newWidth < maxWidth) {
      setExplorerWidth(newWidth);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  return (
    <div className="app" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <div className="editor-container" style={{ cursor: isDragging ? 'col-resize' : 'default' }}>
        <div style={{ width: explorerWidth }}>
          <FileExplorer 
            files={files} 
            onFileSelect={handleFileSelect} 
            selectedFileId={selectedFileId}
            expandedFolders={expandedFolders}
            onExpandedFoldersChange={setExpandedFolders}
          />
        </div>
        <div 
          className="divider" 
          onMouseDown={handleMouseDown}
        />
        <div className="editor-section" style={{ flex: 1 }}>
          <div className="tabs">
            {openTabs.map((tabId) => {
              const file = getFileById(tabId);
              return (
                <div
                  key={tabId}
                  className={`tab ${selectedFileId === tabId ? "active" : ""}`}
                  onClick={() => handleFileSelect(tabId)}
                >
                  <span className="tab-name">{file?.name}</span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTab(tabId);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          {selectedFile && selectedFile.type === "file" ? (
            <Editor content={selectedFile.content || ""} onChange={handleFileChange} />
          ) : (
            <div className="no-file-selected">Select a file to edit</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
