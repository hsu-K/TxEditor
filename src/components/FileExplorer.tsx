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
  selectedFileId: string;
  expandedFolders: Set<string>;
  onExpandedFoldersChange: (expanded: Set<string>) => void;
}

const FileExplorer = ({ files, onFileSelect, selectedFileId, expandedFolders, onExpandedFoldersChange }: FileExplorerProps) => {
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

  const renderFileTree = (items: FileItem[], depth: number = 0) => {
    return (
      <ul className="file-tree" style={{ paddingLeft: depth > 0 ? "15px" : "0" }}>
        {items.map((item) => (
          <li key={item.id} className="file-item">
            <div
              className={`file-row ${selectedFileId === item.id ? "selected" : ""}`}
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
    </div>
  );
}

export default FileExplorer;
