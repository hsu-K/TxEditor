import { useEffect, useState } from "react";
import "./FileExplorer.css";

interface FileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  content?: string;
  children?: FileItem[];
}

interface FileExplorerProps {
  files: FileItem[];
  onFileSelect: (fileId: string) => void;
  onDeleteItem: (itemId: string) => void;
  onCreateFileInFolder: (folderId: string) => void;
  selectedFileId: string;
  expandedFolders: Set<string>;
  onExpandedFoldersChange: (expanded: Set<string>) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  item: FileItem;
}

const FileExplorer = ({
  files,
  onFileSelect,
  onDeleteItem,
  onCreateFileInFolder,
  selectedFileId,
  expandedFolders,
  onExpandedFoldersChange,
}: FileExplorerProps) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener("mousedown", closeContextMenu);

    return () => {
      window.removeEventListener("mousedown", closeContextMenu);
    };
  }, []);

  const toggleFolder = (fileId: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(fileId)) {
      newExpanded.delete(fileId);
    } else {
      newExpanded.add(fileId);
    }
    onExpandedFoldersChange(newExpanded);
  };

//   const TabToggleFolder = useEffect(() => {})

  const handleContextMenu = (event: React.MouseEvent, item: FileItem) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      item,
    });
  };

  const renderFileTree = (items: FileItem[], depth: number = 0) => {
    return (
      <ul className="file-tree" style={{ paddingLeft: depth > 0 ? "15px" : "0" }}>
        {items.map((item) => (
          <li key={item.id} className="file-item">
            <div
              className={`file-row ${selectedFileId === item.id ? "selected" : ""}`}
              onContextMenu={(event) => handleContextMenu(event, item)}
              onClick={() => {
                if (item.type === "folder") {
                  toggleFolder(item.id);
                } else {
                  onFileSelect(item.id);
                }
              }}
            >
              {item.type === "folder" ? (
                <>
                  <span className="folder-icon">
                    {expandedFolders.has(item.id) ? "▼" : "▶"}
                  </span>
                  <span className="folder-name">{item.name}</span>
                </>
              ) : (
                <>
                  <span className="file-icon">📄</span>
                  <span className="file-name">{item.name}</span>
                </>
              )}
            </div>
            {item.type === "folder" && expandedFolders.has(item.id) && item.children  && (
              renderFileTree(item.children, depth + 1)
            )}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="file-explorer">
      <div className="explorer-header">Explorer</div>
      <div className="explorer-content">{renderFileTree(files)}</div>
      {contextMenu && (
        <div
          className="context-menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 180),
            top: Math.min(contextMenu.y, window.innerHeight - (contextMenu.item.type === "folder" ? 88 : 48)),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {contextMenu.item.type === "folder" && (
            <button
              className="context-menu-item"
              onClick={() => {
                onCreateFileInFolder(contextMenu.item.id);
                setContextMenu(null);
              }}
            >
              新增檔案
            </button>
          )}
          <button
            className="context-menu-item danger"
            onClick={() => {
              onDeleteItem(contextMenu.item.id);
              setContextMenu(null);
            }}
          >
            刪除
          </button>
        </div>
      )}
    </div>
  );
}

export default FileExplorer;
