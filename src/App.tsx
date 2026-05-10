import { useState, useEffect, useRef } from "react";
import FileExplorer from "./components/FileExplorer";
import Editor from "./components/Editor";
import "./App.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface FileItem {
  id: string;
  name: string;
  file_path: string;
  type: "file" | "folder";
  content?: string;
  children?: FileItem[];
  parentId?: string;
}

const App = () => {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string>("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [explorerWidth, setExplorerWidth] = useState<number>(250);
  const [isDragging, setIsDragging] = useState(false);
  const [dirtyFileIds, setDirtyFileIds] = useState<Set<string>>(new Set());

  const filesRef = useRef<FileItem[]>([]);
  const dirtyFileIdsRef = useRef<Set<string>>(new Set());
  const savedContentRef = useRef<Map<string, string>>(new Map());
  const isForceClosingRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const isClosingRef = useRef(false);
  const saveInProgressRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    dirtyFileIdsRef.current = dirtyFileIds;
  }, [dirtyFileIds]);

  function convertFileInfo(fileInfo: any): FileItem {
    return {
      id: fileInfo.id,
      name: fileInfo.name,
      file_path: fileInfo.file_path || "",
      type: fileInfo.filetype === "Folder" ? "folder" : "file",
      content: fileInfo.content || undefined,
      children: fileInfo.children 
        ? fileInfo.children.map((child: any) => convertFileInfo(child))
        : undefined,
      parentId: fileInfo.parent_id || undefined,
    };
  }

  const collectFileIds = (item: FileItem): string[] => {
    const childIds = item.children?.flatMap((child) => collectFileIds(child)) || [];
    return [item.id, ...childIds];
  };

  const rememberSavedContents = (items: FileItem[]) => {
    const next = new Map<string, string>();

    const visit = (nodes: FileItem[]) => {
      for (const node of nodes) {
        if (node.type === "file") {
          next.set(node.id, node.content ?? "");
        }
        if (node.children) {
          visit(node.children);
        }
      }
    };

    visit(items);
    savedContentRef.current = next;
  };

  const getFileByIdFromItems = (items: FileItem[], id: string): FileItem | undefined => {
    const search = (nodes: FileItem[]): FileItem | undefined => {
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
          const found = search(node.children);
          if (found) return found;
        }
      }
      return undefined;
    };

    return search(items);
  };

  const markFileDirty = (fileId: string, content: string) => {
    const lastSavedContent = savedContentRef.current.get(fileId);
    if (lastSavedContent === content) {
      const next = new Set(dirtyFileIdsRef.current);
      next.delete(fileId);
      dirtyFileIdsRef.current = next;
      setDirtyFileIds(next);
      return;
    }

    const next = new Set(dirtyFileIdsRef.current);
    next.add(fileId);
    dirtyFileIdsRef.current = next;
    setDirtyFileIds(next);
  };

  const saveFileById = async (fileId: string) => {
    const file = getFileByIdFromItems(filesRef.current, fileId);
    if (!file || file.type !== "file") {
      return;
    }

    const content = file.content ?? "";
    const lastSavedContent = savedContentRef.current.get(fileId);
    if (lastSavedContent === content) {
      const next = new Set(dirtyFileIdsRef.current);
      next.delete(fileId);
      dirtyFileIdsRef.current = next;
      setDirtyFileIds(next);
      return;
    }

    await invoke("save_file_content", {
      fileId,
      newContent: content,
    });

    savedContentRef.current.set(fileId, content);
    const next = new Set(dirtyFileIdsRef.current);
    next.delete(fileId);
    dirtyFileIdsRef.current = next;
    setDirtyFileIds(next);
  };

  const saveDirtyFiles = async () => {
    if (saveInProgressRef.current) {
      return saveInProgressRef.current;
    }

    const saveTask = (async () => {
      const dirtyIds = Array.from(dirtyFileIdsRef.current);

      for (const fileId of dirtyIds) {
        try {
          await saveFileById(fileId);
        } catch (error) {
          console.error(`Failed to auto-save ${fileId}:`, error);
        }
      }
    })();

    saveInProgressRef.current = saveTask.finally(() => {
      saveInProgressRef.current = null;
    });

    return saveInProgressRef.current;
  };

  async function fetchFiles(options?: { resetExpansion?: boolean; expandFolderIds?: string[] }) {
    const result = await invoke("list_all_files");
    const convertedFiles = (result as any[]).map(file => convertFileInfo(file));
    filesRef.current = convertedFiles;
    setFiles(convertedFiles);
    rememberSavedContents(convertedFiles);

    if (options?.resetExpansion) {
      // 啟動時只展開 documents 這一層，子資料夾維持收合
      const documentsNode = convertedFiles.find(
        (item) => item.type === "folder" && item.name === "documents"
      );
      setExpandedFolders(documentsNode ? new Set([documentsNode.id]) : new Set());
    }

    if (options?.expandFolderIds?.length) {
      setExpandedFolders((current) => {
        const next = new Set(current);
        options.expandFolderIds?.forEach((folderId) => next.add(folderId));
        return next;
      });
    }
  }

  useEffect(() => {
    fetchFiles({ resetExpansion: true });
  }, []);

  useEffect(() => {
    autosaveTimerRef.current = window.setInterval(() => {
      void saveDirtyFiles();
    }, 5000);

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearInterval(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupCloseHandler = async () => {
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested((event) => {
        if (isForceClosingRef.current) {
          return;
        }

        event.preventDefault();

        if (isClosingRef.current) {
          return;
        }

        isClosingRef.current = true;

        if (autosaveTimerRef.current !== null) {
          window.clearInterval(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }

        void (async () => {
          if (autosaveTimerRef.current !== null) {
            window.clearInterval(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
          }

          try {
            await saveDirtyFiles();
            isForceClosingRef.current = true;
            unlisten?.();
            window.setTimeout(() => {
              void appWindow.close();
            }, 0);
          } catch (error) {
            isForceClosingRef.current = false;
            isClosingRef.current = false;
            window.alert(error instanceof Error ? error.message : "關閉前存檔失敗");
          }
        })();
      });
    };

    void setupCloseHandler();

    return () => {
      void unlisten?.();
    };
  }, []);

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
  const handleFileSelect = async (fileId: string) => {
    const file = getFileById(fileId);
    if (file && file.type === "file") {
      setSelectedFileId(fileId);
      if (!openTabs.includes(fileId)) {
        setOpenTabs([...openTabs, fileId]);
      }
      
      // 自動展開該文件所在的所有父文件夾
      const parentFolders: string[] = await invoke("get_parent_folders", { fileId });
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

    const nextFiles = updateFileContent(filesRef.current);
    filesRef.current = nextFiles;
    setFiles(nextFiles);
    markFileDirty(selectedFileId, content);
  };

  // 處理tab被關閉的情況，若正好是當前選中的文件被關閉，則切換到最後一個打開的tab
  // 若所有tabs都關閉，則清空selectedFileId
  const handleCloseTab = async (fileId: string) => {
    try {
      if (dirtyFileIdsRef.current.has(fileId)) {
        await saveFileById(fileId);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "存檔失敗");
      return;
    }

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

  const handleDeleteItem = async (itemId: string) => {
    const item = getFileById(itemId);
    if (!item) {
      return;
    }

    const confirmed = window.confirm(`確定要刪除 ${item.name} 嗎？`);
    if (!confirmed) {
      return;
    }

    const deletedIds = new Set(collectFileIds(item));

    try {
      await invoke("delete_item", { itemId });

      const nextTabs = openTabs.filter((tabId) => !deletedIds.has(tabId));
      setOpenTabs(nextTabs);
      setExpandedFolders((current) => {
        const next = new Set(current);
        deletedIds.forEach((deletedId) => next.delete(deletedId));
        return next;
      });

      if (deletedIds.has(selectedFileId)) {
        setSelectedFileId(nextTabs.length > 0 ? nextTabs[nextTabs.length - 1] : "");
      }

      await fetchFiles();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "刪除失敗");
    }
  };

  const handleCreateFileInFolder = async (folderId: string) => {
    const fileName = window.prompt("請輸入新檔案名稱", "new_file");
    if (!fileName) {
      return;
    }

    const normalizedFileName = fileName.trim();
    if (!normalizedFileName) {
      return;
    }

    if (normalizedFileName.includes("/") || normalizedFileName.includes("\\")) {
      window.alert("檔名不能包含路徑分隔符號");
      return;
    }

    try {
      console.log(`Creating file '${normalizedFileName}' in folder '${folderId}'`);
        const createdFile = await invoke<FileItem>("create_file_in_folder", {
          folderId,
          fileName: normalizedFileName,
      });
      
      console.log("Created file:", createdFile);
      await fetchFiles();
      setOpenTabs((current) => (current.includes(createdFile.id) ? current : [...current, createdFile.id]));
      setSelectedFileId(createdFile.id);
      setExpandedFolders((current) => {
        const next = new Set(current);
        next.add(folderId);
        return next;
      });
    } catch (error) {
      console.error("Backend error:", error);
      window.alert(error instanceof Error ? error.message : "建立檔案失敗");
    }
  };

  const handleCreateFolderInFolder = async (folderId: string) => {
    const folderName = window.prompt("請輸入新資料夾名稱", "new_folder");
    if (!folderName) {
      return;
    }

    const normalizedFolderName = folderName.trim();
    if (!normalizedFolderName) {
      return;
    }

    if (normalizedFolderName.includes("/") || normalizedFolderName.includes("\\")) {
      window.alert("資料夾名稱不能包含路徑分隔符號");
      return;
    }

    try {
      console.log(`Creating folder '${normalizedFolderName}' in folder '${folderId}'`);
        const createdFolder = await invoke<FileItem>("create_folder_in_folder", {
          folderId,
          folderName: normalizedFolderName,
      });
      
      console.log("Created folder:", createdFolder);
      await fetchFiles();
      setOpenTabs((current) => (current.includes(createdFolder.id) ? current : [...current, createdFolder.id]));
      setSelectedFileId(createdFolder.id);
      setExpandedFolders((current) => {
        const next = new Set(current);
        next.add(folderId);
        return next;
      });
    } catch (error) {
      console.error("Backend error:", error);
      window.alert(error instanceof Error ? error.message : "建立資料夾失敗");
    }
  };
  const handleMoveItem = async (itemId: string, targetFolderId: string) => {
    console.log(`🔄 移動項目 ${itemId} -> ${targetFolderId}`);

    try {
      await invoke("move_item", {
        itemId,
        targetFolderId,
      });

      await fetchFiles({ expandFolderIds: [targetFolderId] });
      setExpandedFolders((current) => {
        const next = new Set(current);
        next.add(targetFolderId);
        return next;
      });

      console.log(`✅ 已完成移動 ${itemId}`);
    } catch (error) {
      console.error(`❌ 移動失敗 ${itemId} -> ${targetFolderId}:`, error);
      throw error;
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
            onDeleteItem={handleDeleteItem}
            onCreateFileInFolder={handleCreateFileInFolder}
            onCreateFolderInFolder={handleCreateFolderInFolder}
            onMoveItem={handleMoveItem}
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
                      void handleCloseTab(tabId);
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
