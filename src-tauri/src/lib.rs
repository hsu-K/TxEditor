use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use once_cell::sync::Lazy;
use std::sync::Mutex;
use std::collections::HashMap;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::OptionalExtension;
use std::sync::OnceLock;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
enum FileType {
    File,
    Folder,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileInfo {
    id: String,
    name: String,
    file_path: Option<String>,
    filetype: FileType,
    content: String,
    children: Option<Vec<FileInfo>>,
    parent_id: Option<String>,
}

static FILE_MAP: Lazy<Mutex<HashMap<String, FileInfo>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static FILE_TREE: Lazy<Mutex<Vec<FileInfo>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn update_file_map(file_info: &FileInfo) {
    let mut file_map = FILE_MAP.lock().unwrap();
    file_map.insert(file_info.id.clone(), file_info.clone());
}

// 獲取指定目錄下的所有文件和文件夾信息
#[tauri::command]
// fn get_files(dirpath: &str, now_id: &str) -> Vec<FileInfo> {
//     let path = PathBuf::from(&dirpath);
//     if !(path.exists() && path.is_dir()) {
//         return vec![];
//     }
//     let mut files = Vec::new();
//     let mut id_counter: i32 = 1;

//     // let mut file_map = FILE_MAP.lock().unwrap();

//     match fs::read_dir(path) {
//         Ok(entries) => {
//             for entry in entries {
//                 match entry {
//                     Ok(entry) => {
//                         // println!("{:?}", entry.metadata());
//                         let file_type = if let Ok(metadata) = entry.metadata() {
//                             if metadata.is_dir() {
//                                 FileType::Folder
//                             } else {
//                                 FileType::File
//                             }
//                         } else {
//                             FileType::File // Default to File if metadata cannot be read
//                         };

//                         let mut file_info = FileInfo {
//                             id: now_id.to_string() + &id_counter.to_string(),
//                             name: entry.file_name().to_string_lossy().to_string(),
//                             file_path: Some(entry.path().to_string_lossy().to_string()),
//                             filetype: file_type,
//                             content: String::new(),
//                             children: None,
//                         };

//                         if file_info.filetype == FileType::Folder {
//                             println!("Folder: {}", file_info.name);
//                             let subfolder_files: Vec<FileInfo> = get_files(&entry.path().to_string_lossy().to_string(), &format!("{}-", file_info.id));
//                             file_info.children = Some(subfolder_files);
//                         } else {
//                             file_info.content = get_file_content(&entry.path().to_string_lossy().to_string());
//                             println!("File: {}", file_info.name);
//                         }
//                         // file_map.insert(file_info.id.clone(), file_info.clone());
//                         update_file_map(&file_info);
//                         files.push(file_info);
//                         id_counter += 1;
//                     }
//                     Err(_) => continue,
//                 }
//             }
//         }
//         Err(e) => Err(e.to_string()).unwrap_or_else(|err| {
//             eprintln!("Error reading directory: {}", err);
//         }),
//     }
//     files
// }

// 讀取文件內容
fn get_file_content(file_path: &str) -> String {
    match fs::read_to_string(file_path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("Error reading file: {}", e);
            String::new()
        }
    }
}

fn save_file_content(file_path: &str, file_id: &str, new_content: &str) -> Result<bool, String> {
    // 寫入文件系統
    fs::write(file_path, new_content).map_err(|e| format!("Failed to write file: {}", e))?;
    
    // 更新 FILE_MAP
    let mut file_map = FILE_MAP.lock().unwrap();
    if let Some(file_info) = file_map.get_mut(file_id) {
        file_info.content = new_content.to_string();
    }

    Ok(true)
}

// 列出所有文件和文件夾信息，並更新全局 FILE_LIST
#[tauri::command]
fn list_all_files() -> Vec<FileInfo> {
    FILE_MAP.lock().unwrap().clear();
    // let files = get_files("..\\TxtFiles", "");
    let files = list_entries(None);
    match files {
        Ok(files) => {
            *FILE_TREE.lock().unwrap() = files.clone();
            files
        }
        Err(e) => {
            eprintln!("Error listing files: {}", e);
            vec![]
        }
    }
    // let _ = save_file_content("..\\TxtFiles\\testFolder\\innerFile", "3-1", "This is save test");
    // println!("FileTree: {:?}", FILE_TREE.lock().unwrap());
}

static DB_POOL: OnceLock<r2d2::Pool<SqliteConnectionManager>> = OnceLock::new();

fn construct_path(folder_id: i32) -> Result<String, Box<dyn std::error::Error>> {
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    let conn = pool.get()?;
    
    let (path, parent_id): (String, Option<i32>) = conn.query_row(
        "SELECT name, parent_id FROM folders WHERE id = ?1",
        rusqlite::params![folder_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i32>>(1)?,
            ))
        }
    )?;
    match parent_id {
        Some(pid) => {
            let parent_path = construct_path(pid)?;
            Ok(format!("{}/{}", parent_path.trim_end_matches('/'), path.trim_start_matches('/')))
        }
        None => Ok(path)
    }
}

fn list_entries(parent_id: Option<i32>) -> Result<Vec<FileInfo>, Box<dyn std::error::Error>> {
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    let conn = pool.get()?;

    let mut stmt = conn.prepare(
        "SELECT id, name AS title, path, 'folder' AS kind
        FROM folders
        WHERE parent_id IS ?1
        UNION ALL
        SELECT id, title AS title, path, 'file' AS kind
        FROM notes
        WHERE folder_id IS ?1
        ORDER BY kind DESC, title COLLATE NOCASE"
    )?;

    let rows = stmt.query_map(rusqlite::params![parent_id], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    let mut result = Vec::new();

    for row in rows {
        let (id, name, path, kind) = row?;
        if kind == "folder" {
            let children = list_entries(Some(id))?;
            result.push(FileInfo {
                id: format!("folder-{}", id),
                name,
                file_path: Some(path),
                filetype: FileType::Folder,
                content: String::new(),
                children: Some(children),
                parent_id: parent_id.map(|pid| format!("folder-{}", pid)),
            });
        } else {
            result.push(FileInfo {
                id: format!("file-{}", id),
                name,
                file_path: Some(path.clone()),
                filetype: FileType::File,
                content: get_file_content(&path),
                children: None,
                parent_id: parent_id.map(|pid| format!("folder-{}", pid)),
            });
        }
    }

    Ok(result)
}

fn normalize_path_for_db(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn init_db(data_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(data_dir)?;

    let db_path = data_dir.join("editor_data.db");
    let documents_dir = data_dir.join("documents");
    let documents_path = normalize_path_for_db(&documents_dir);

    let mgr = SqliteConnectionManager::file(db_path);
    let pool = r2d2::Pool::new(mgr).unwrap();
    
    let conn = pool.get().unwrap();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,          -- 指向父資料夾的 ID，根目錄為 NULL
            path TEXT UNIQUE NOT NULL,   -- 絕對路徑，方便與檔案系統對接
            FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
        )", 
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER,          -- 所屬資料夾
            title TEXT NOT NULL,
            path TEXT UNIQUE NOT NULL,   -- 檔案路徑
            updated_at DATETIME,
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // 初始化資料庫後，固定建立 documents 作為檔案系統根目錄
    fs::create_dir_all(&documents_dir)?;

    // 確保資料庫中也有對應的根資料夾紀錄
    conn.execute(
        "INSERT INTO folders (name, parent_id, path)
         VALUES (?1, NULL, ?2)
         ON CONFLICT(path) DO NOTHING",
        rusqlite::params!["documents", documents_path],
    )?;

    let _ = DB_POOL.set(pool);
    Ok(())
}

#[tauri::command]
fn get_parent_folders(fileId: &str) -> Vec<String> {
    let pool = match DB_POOL.get() {
        Some(pool) => pool,
        None => return vec![],
    };

    let conn = match pool.get() {
        Ok(conn) => conn,
        Err(_) => return vec![],
    };

    // 以目標節點為起點，先找到第一個父資料夾 id。
    let mut current_parent_id: Option<i32> = if let Some(raw_id) = fileId.strip_prefix("file-") {
        let file_id = match raw_id.parse::<i32>() {
            Ok(id) => id,
            Err(_) => return vec![],
        };

        match conn
            .query_row(
                "SELECT folder_id FROM notes WHERE id = ?1",
                rusqlite::params![file_id],
                |row| row.get::<_, Option<i32>>(0),
            )
            .optional()
        {
            Ok(value) => value.flatten(),
            Err(_) => return vec![],
        }
    } else if let Some(raw_id) = fileId.strip_prefix("folder-") {
        let folder_id = match raw_id.parse::<i32>() {
            Ok(id) => id,
            Err(_) => return vec![],
        };

        match conn
            .query_row(
                "SELECT parent_id FROM folders WHERE id = ?1",
                rusqlite::params![folder_id],
                |row| row.get::<_, Option<i32>>(0),
            )
            .optional()
        {
            Ok(value) => value.flatten(),
            Err(_) => return vec![],
        }
    } else {
        return vec![];
    };

    let mut parents: Vec<String> = Vec::new();

    while let Some(folder_id) = current_parent_id {
        parents.push(format!("folder-{}", folder_id));

        current_parent_id = match conn
            .query_row(
                "SELECT parent_id FROM folders WHERE id = ?1",
                rusqlite::params![folder_id],
                |row| row.get::<_, Option<i32>>(0),
            )
            .optional()
        {
            Ok(value) => value.flatten(),
            Err(_) => break,
        };
    }

    // 回傳順序調整為：從根到最接近目標的父資料夾。
    parents.reverse();
    parents
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            init_db(&app_data_dir).map_err(|e| {
                eprintln!("Failed to initialize database: {}", e);
                e
            })?;
            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, list_all_files, get_parent_folders])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
