import { useEffect, useState, useRef } from "react";
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
  onCreateFolderInFolder: (folderId: string) => void;
  onMoveItem: (itemId: string, targetFolderId: string) => Promise<void>;
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
  onCreateFolderInFolder,
  onMoveItem,
  selectedFileId,
  expandedFolders,
  onExpandedFoldersChange,
}: FileExplorerProps) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const draggedItemIdRef = useRef<string | null>(null);

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

  const handleDragStart = (e: React.DragEvent, item: FileItem) => {
    console.log(`🎯 拖拉開始: ${item.name} (ID: ${item.id})`);
    draggedItemIdRef.current = item.id;
    setDraggedItemId(item.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.id);
  };

  const handleDragEnd = () => {
    console.log("🛑 拖拉結束");
    draggedItemIdRef.current = null;
    setDraggedItemId(null);
    setDragOverFolderId(null);
  };

  const handleDragOver = (e: React.DragEvent, folderId: string) => {
    if (draggedItemIdRef.current && draggedItemIdRef.current !== folderId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverFolderId(folderId);
      console.log(`🚀 懸停在資料夾上: ${folderId}`);
    }
  };

  const handleDragLeave = () => {
    setDragOverFolderId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    
    const draggedId = draggedItemIdRef.current;
    draggedItemIdRef.current = null;
    setDraggedItemId(null);
    setDragOverFolderId(null);

    if (!draggedId) {
      console.log("❌ 無效的拖拉操作");
      return;
    }

    if (targetFolder.type !== "folder") {
      console.log("❌ 目標不是資料夾");
      return;
    }

    if (draggedId === targetFolder.id) {
      console.log("❌ 無法將項目移動到自己");
      return;
    }

    console.log(`📦 放下: 項目 ${draggedId} 移動到資料夾 ${targetFolder.name} (ID: ${targetFolder.id})`);
    
    try {
      await onMoveItem(draggedId, targetFolder.id);
      console.log("✅ 移動成功");
    } catch (error) {
      console.error("❌ 移動失敗:", error);
    }
  };

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
              className={`file-row ${selectedFileId === item.id ? "selected" : ""} ${draggedItemId === item.id ? "dragging" : ""} ${dragOverFolderId === item.id ? "drag-over" : ""}`}
              draggable={true}
              onDragStart={(e) => handleDragStart(e, item)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => {
                if (item.type !== "folder") {
                  return;
                }

                handleDragOver(e, item.id);
              }}
              onDragLeave={handleDragLeave}
              onDrop={(e) => item.type === "folder" && handleDrop(e, item)}
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
            <div>
              <button
                className="context-menu-item"
                onClick={() => {
                  onCreateFileInFolder(contextMenu.item.id);
                  setContextMenu(null);
                }}
              >
                新增檔案
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  onCreateFolderInFolder(contextMenu.item.id);
                  setContextMenu(null);
                }}
              >
                新增資料夾
              </button>  
            </div>  
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
