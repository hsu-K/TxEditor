import { useRef, useEffect, useState } from "react";
import "./Editor.css";

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
}

interface HistoryState {
  content: string;
  cursorOffset: number;
}

const Editor = ({ content, onChange }: EditorProps) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastContentRef = useRef<string>(content);
  const historyRef = useRef<HistoryState[]>([{ content, cursorOffset: 0 }]);
  const historyIndexRef = useRef<number>(0);
  const [, setUpdateTrigger] = useState(0);

  // 只在 content 發生外部變化時更新（例如切換檔案），而不是由輸入引起的變化
  useEffect(() => {
    if (editorRef.current && content !== lastContentRef.current) {
      editorRef.current.innerHTML = content;
      lastContentRef.current = content;
      // 重置歷史記錄
      historyRef.current = [{ content, cursorOffset: 0 }];
      historyIndexRef.current = 0;
    }
  }, [content]);

  // 獲取光標在內容中的偏移位置
  const getCursorOffset = (): number => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editorRef.current) return 0;

    const range = sel.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(editorRef.current);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    return preCaretRange.toString().length;
  };

  // 設置光標到指定的偏移位置
  const setCursorToOffset = (offset: number) => {
    if (!editorRef.current) return;

    const sel = window.getSelection();
    const range = document.createRange();
    let charCount = 0;
    const nodeStack: Node[] = [editorRef.current];
    let node: Node | undefined = undefined;
    let foundStart = false;

    while (!foundStart && (node = nodeStack.pop())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const textNode = node as Text;
        const nextCharCount = charCount + textNode.length;
        if (offset <= nextCharCount) {
          range.setStart(textNode, offset - charCount);
          foundStart = true;
        }
        charCount = nextCharCount;
      } else if (node.nodeType !== Node.TEXT_NODE) {
        const element = node as Element;
        let i = element.childNodes.length;
        while (i--) {
          nodeStack.push(element.childNodes[i]);
        }
      }
    }

    if (foundStart) {
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  const addToHistory = (newContent: string) => {
    // 如果不是在歷史末尾，刪除未來的歷史
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    }
    
    // 添加新的歷史記錄（包含光標位置）
    const cursorOffset = getCursorOffset();
    historyRef.current.push({ content: newContent, cursorOffset });
    historyIndexRef.current = historyRef.current.length - 1;
  };

  const undo = () => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      const previousState = historyRef.current[historyIndexRef.current];
      if (editorRef.current) {
        editorRef.current.innerHTML = previousState.content;
        lastContentRef.current = previousState.content;
        onChange(previousState.content);
        // 恢復光標到撤銷前的位置
        setCursorToOffset(previousState.cursorOffset);
        setUpdateTrigger(prev => prev + 1);
      }
    }
  };

  const redo = () => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      const nextState = historyRef.current[historyIndexRef.current];
      if (editorRef.current) {
        editorRef.current.innerHTML = nextState.content;
        lastContentRef.current = nextState.content;
        onChange(nextState.content);
        // 恢復光標到重做後的位置
        setCursorToOffset(nextState.cursorOffset);
        setUpdateTrigger(prev => prev + 1);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
      e.preventDefault();
      redo();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.indexOf("image") !== -1) {
        // 處理圖片
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (event) => {
            const img = document.createElement("img");
            img.src = event.target?.result as string;
            img.className = "pasted-image";
            if (editorRef.current) {
              // 創建一個空的文本節點用於光標位置
              const emptyNode = document.createTextNode("");
              editorRef.current.appendChild(img);
              editorRef.current.appendChild(emptyNode);
              
              // 設置光標到文本節點（圖片之後）
              const range = document.createRange();
              const sel = window.getSelection();
              range.setStart(emptyNode, 0);
              range.collapse(true);
              sel?.removeAllRanges();
              sel?.addRange(range);
              
              // 更新內容到 onChange 並添加到歷史記錄
              const html = editorRef.current.innerHTML;
              lastContentRef.current = html;
              addToHistory(html);
              onChange(html);
            }
          };
          reader.readAsDataURL(file);
        }
      } else if (item.type === "text/plain") {
        // 處理文本
        item.getAsString((text) => {
          document.execCommand("insertText", false, text);
          if (editorRef.current) {
            const html = editorRef.current.innerHTML;
            lastContentRef.current = html;
            addToHistory(html);
            onChange(html);
          }
        });
      }
    }
  };

  const handleInput = () => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      lastContentRef.current = html;
      addToHistory(html);
      onChange(html);
    }
  };

  return (
    <div className="editor">
      <div
        ref={editorRef}
        className="editor-content"
        contentEditable
        onPaste={handlePaste}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        suppressContentEditableWarning
      />
    </div>
  );
}

export default Editor;
