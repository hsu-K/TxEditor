use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use once_cell::sync::Lazy;
use std::sync::Mutex;
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

static FILE_TREE: Lazy<Mutex<Vec<FileInfo>>> = Lazy::new(|| Mutex::new(Vec::new()));

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

#[tauri::command]
fn save_file_content(file_id: &str, new_content: &str) -> Result<(), String> {
    let (_, raw_file_id) = parse_item_id(file_id)?;
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    let conn = pool.get().map_err(|e| format!("Failed to access database: {}", e))?;

    let file_path = get_file_path(&conn, raw_file_id)?;
    fs::write(&file_path, new_content)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    conn.execute(
        "UPDATE notes SET updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![raw_file_id],
    )
    .map_err(|e| format!("Failed to update file metadata: {}", e))?;

    Ok(())
}

// 啟用 SQLite 外鍵支持
// fn enable_foreign_keys(conn: &rusqlite::Connection) -> Result<(), String> {
//     conn.execute_batch("PRAGMA foreign_keys = ON;")
//         .map_err(|e| format!("Failed to enable foreign keys: {}", e))
// }

// 解析 item_id，返回 (prefix, id)，例如 "file-123" -> ("file", 123)
fn parse_item_id(item_id: &str) -> Result<(String, i32), String> {
    let (prefix, raw_id) = item_id
        .split_once('-')
        .ok_or_else(|| "Invalid item id".to_string())?;

    let id = raw_id
        .parse::<i32>()
        .map_err(|_| "Invalid item id".to_string())?;

    Ok((prefix.to_string(), id))
}

// 取的folder或file的path，返回PathBuf
fn get_folder_path(conn: &rusqlite::Connection, folder_id: i32) -> Result<PathBuf, String> {
    let path = conn
        .query_row(
            "SELECT path FROM folders WHERE id = ?1",
            rusqlite::params![folder_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query folder path: {}", e))?
        .ok_or_else(|| "Folder not found".to_string())?;

    Ok(PathBuf::from(path))
}

fn get_file_path(conn: &rusqlite::Connection, file_id: i32) -> Result<PathBuf, String> {
    let path = conn
        .query_row(
            "SELECT path FROM notes WHERE id = ?1",
            rusqlite::params![file_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query file path: {}", e))?
        .ok_or_else(|| "File not found".to_string())?;

    Ok(PathBuf::from(path))
}

fn path_exists_in_db(conn: &rusqlite::Connection, path: &str) -> Result<bool, String> {
    let note_exists = conn
        .query_row(
            "SELECT 1 FROM notes WHERE path = ?1 LIMIT 1",
            rusqlite::params![path],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("Failed to check file name: {}", e))?
        .is_some();

    if note_exists {
        return Ok(true);
    }

    let folder_exists = conn
        .query_row(
            "SELECT 1 FROM folders WHERE path = ?1 LIMIT 1",
            rusqlite::params![path],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("Failed to check file name: {}", e))?
        .is_some();

    Ok(folder_exists)
}

// 根據請求的名稱生成一個唯一的文件名稱，並返回該名稱和對應的完整路徑
fn build_unique_file_name(
    conn: &rusqlite::Connection,
    folder_path: &Path,
    requested_name: &str,
) -> Result<(String, PathBuf), String> {
    let requested_name = requested_name.trim();
    if requested_name.is_empty() {
        return Err("File name cannot be empty".to_string());
    }

    if requested_name.contains('/') || requested_name.contains('\\') {
        return Err("File name cannot contain path separators".to_string());
    }

    // 分解主名和副檔名
    let requested_path = Path::new(requested_name);
    let stem = requested_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(requested_name);
    let extension = requested_path.extension().and_then(|value| value.to_str());

    for index in 0..1000 {
        let candidate_name = if index == 0 {
            requested_name.to_string()
        } else if let Some(extension) = extension {
            format!("{} ({}).{}", stem, index, extension)
        } else {
            format!("{} ({})", stem, index)
        };

        let candidate_path = folder_path.join(&candidate_name);
        let candidate_db_path = normalize_path_for_db(&candidate_path);

        if !candidate_path.exists() && !path_exists_in_db(conn, &candidate_db_path)? {
            return Ok((candidate_name, candidate_path));
        }
    }

    Err("Unable to generate a unique file name".to_string())
}

#[tauri::command]
fn create_file_in_folder(folder_id: &str, file_name: &str) -> Result<FileInfo, String> {
    // eprintln!("Creating file '{}' in folder '{}'", file_name, folder_id);
    let (_, raw_folder_id) = parse_item_id(folder_id)?;
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    let conn = pool.get().map_err(|e| format!("Failed to access database: {}", e))?;

    // enable_foreign_keys(&conn)?;

    let folder_path = get_folder_path(&conn, raw_folder_id)?;
    // 確保資料夾存在，如果不存在則建立
    fs::create_dir_all(&folder_path)
        .map_err(|e| format!("Failed to prepare folder: {}", e))?;

    // 生成唯一的文件名稱和對應的完整路徑
    let (candidate_name, candidate_path) = build_unique_file_name(&conn, &folder_path, file_name)?;
    fs::File::create(&candidate_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let db_path = normalize_path_for_db(&candidate_path);
    conn.execute(
        "INSERT INTO notes (folder_id, title, path, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))",
        rusqlite::params![raw_folder_id, candidate_name, db_path],
    )
    .map_err(|e| format!("Failed to create database record: {}", e))?;

    let created_id = conn.last_insert_rowid() as i32;

    Ok(FileInfo {
        id: format!("file-{}", created_id),
        name: candidate_name,
        file_path: Some(normalize_path_for_db(&candidate_path)),
        filetype: FileType::File,
        content: String::new(),
        children: None,
        parent_id: Some(format!("folder-{}", raw_folder_id)),
    })
}

#[tauri::command]
fn create_folder_in_folder(folder_id: &str, folder_name: &str) -> Result<FileInfo, String> {
    // eprintln!("Creating folder '{}' in folder '{}'", folder_name, folder_id);
    let (_, raw_folder_id) = parse_item_id(folder_id)?;
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    let conn = pool.get().map_err(|e| format!("Failed to access database: {}", e))?;

    // enable_foreign_keys(&conn)?;

    let folder_path = get_folder_path(&conn, raw_folder_id)?;
    // 確保資料夾存在，如果不存在則建立
    fs::create_dir_all(&folder_path)
        .map_err(|e| format!("Failed to prepare folder: {}", e))?;

    // 生成唯一的文件名稱和對應的完整路徑
    let (candidate_name, candidate_path) = build_unique_file_name(&conn, &folder_path, folder_name)?;
    fs::create_dir_all(&candidate_path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;

    let db_path = normalize_path_for_db(&candidate_path);
    conn.execute(
        "INSERT INTO folders (name, parent_id, path)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![candidate_name, raw_folder_id, db_path],
    )
    .map_err(|e| format!("Failed to create database record: {}", e))?;

    let created_id = conn.last_insert_rowid() as i32;

    Ok(FileInfo {
        id: format!("folder-{}", created_id),
        name: candidate_name,
        file_path: Some(normalize_path_for_db(&candidate_path)),
        filetype: FileType::Folder,
        content: String::new(),
        children: None,
        parent_id: Some(format!("folder-{}", raw_folder_id)),
    })
}

#[tauri::command]
fn delete_item(item_id: &str) -> Result<(), String> {
    let (prefix, raw_id) = parse_item_id(item_id)?;
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    let conn = pool.get().map_err(|e| format!("Failed to access database: {}", e))?;

    // enable_foreign_keys(&conn)?;

    // 根據前墜識別是文件還是資料夾，執行相應的刪除邏輯
    match prefix.as_str() {
        "file" => {
            let file_path = get_file_path(&conn, raw_id)?;
            fs::remove_file(&file_path)
                .map_err(|e| format!("Failed to delete file: {}", e))?;

            conn.execute(
                "DELETE FROM notes WHERE id = ?1",
                rusqlite::params![raw_id],
            )
            .map_err(|e| format!("Failed to remove file record: {}", e))?;
        }
        "folder" => {
            let (folder_path, parent_id): (String, Option<i32>) = conn
                .query_row(
                    "SELECT path, parent_id FROM folders WHERE id = ?1",
                    rusqlite::params![raw_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
                )
                .optional()
                .map_err(|e| format!("Failed to query folder: {}", e))?
                .ok_or_else(|| "Folder not found".to_string())?;

            if parent_id.is_none() {
                return Err("The root folder cannot be deleted".to_string());
            }

            fs::remove_dir_all(&folder_path)
                .map_err(|e| format!("Failed to delete folder: {}", e))?;

            conn.execute(
                "DELETE FROM folders WHERE id = ?1",
                rusqlite::params![raw_id],
            )
            .map_err(|e| format!("Failed to remove folder record: {}", e))?;
        }
        _ => return Err("Unknown item type".to_string()),
    }

    Ok(())
}

fn path_is_same_or_descendant(candidate: &str, base: &str) -> bool {
    candidate == base || candidate.starts_with(&format!("{}/", base))
}

fn replace_path_prefix(path: &str, old_prefix: &str, new_prefix: &str) -> Result<String, String> {
    if !path.starts_with(old_prefix) {
        return Err("Path prefix mismatch while moving item".to_string());
    }

    Ok(format!("{}{}", new_prefix, &path[old_prefix.len()..]))
}

fn move_file_record(
    conn: &mut rusqlite::Connection,
    raw_file_id: i32,
    raw_target_folder_id: i32,
) -> Result<(), String> {
    let (old_path, file_name, current_folder_id): (String, String, Option<i32>) = conn
        .query_row(
            "SELECT path, title, folder_id FROM notes WHERE id = ?1",
            rusqlite::params![raw_file_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i32>>(2)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to query file: {}", e))?
        .ok_or_else(|| "File not found".to_string())?;

    if current_folder_id == Some(raw_target_folder_id) {
        return Ok(());
    }

    let target_folder_path = get_folder_path(conn, raw_target_folder_id)?;
    let new_path = target_folder_path.join(&file_name);
    let new_path_db = normalize_path_for_db(&new_path);

    if path_exists_in_db(conn, &new_path_db)? {
        return Err("Target location already has a file or folder with the same name".to_string());
    }

    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to move file on disk: {}", e))?;

    conn.execute(
        "UPDATE notes SET folder_id = ?1, path = ?2 WHERE id = ?3",
        rusqlite::params![raw_target_folder_id, new_path_db, raw_file_id],
    )
    .map_err(|e| format!("Failed to update file record: {}", e))?;

    Ok(())
}

fn move_folder_record(
    conn: &mut rusqlite::Connection,
    raw_folder_id: i32,
    raw_target_folder_id: i32,
) -> Result<(), String> {
    let (old_path, folder_name, current_parent_id): (String, String, Option<i32>) = conn
        .query_row(
            "SELECT path, name, parent_id FROM folders WHERE id = ?1",
            rusqlite::params![raw_folder_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i32>>(2)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to query folder: {}", e))?
        .ok_or_else(|| "Folder not found".to_string())?;

    if current_parent_id == Some(raw_target_folder_id) {
        return Ok(());
    }

    if current_parent_id.is_none() {
        return Err("The root folder cannot be moved".to_string());
    }

    let target_folder_path = get_folder_path(conn, raw_target_folder_id)?;
    let target_folder_path_db = normalize_path_for_db(&target_folder_path);
    if path_is_same_or_descendant(&target_folder_path_db, &old_path) {
        return Err("Parent folders cannot be moved into their own child folders".to_string());
    }

    let new_folder_path = target_folder_path.join(&folder_name);
    let new_folder_path_db = normalize_path_for_db(&new_folder_path);

    if path_exists_in_db(conn, &new_folder_path_db)? {
        return Err("Target location already has a file or folder with the same name".to_string());
    }

    fs::rename(&old_path, &new_folder_path)
        .map_err(|e| format!("Failed to move folder on disk: {}", e))?;

    let tx_result: Result<(), String> = (|| {
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        tx.execute(
            "UPDATE folders SET parent_id = ?1, path = ?2 WHERE id = ?3",
            rusqlite::params![raw_target_folder_id, new_folder_path_db.clone(), raw_folder_id],
        )
        .map_err(|e| format!("Failed to update moved folder record: {}", e))?;

        let mut folder_stmt = tx
            .prepare(
                "SELECT id, path FROM folders
                 WHERE id != ?1
                   AND instr(path, ?2) = 1
                   AND (length(path) = length(?2) OR substr(path, length(?2) + 1, 1) = '/')",
            )
            .map_err(|e| format!("Failed to prepare folder update query: {}", e))?;
        let folder_rows = folder_stmt
            .query_map(rusqlite::params![raw_folder_id, old_path], |row| {
                Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query descendant folders: {}", e))?;

        for row in folder_rows {
            let (folder_id, path) = row.map_err(|e| format!("Failed to read folder row: {}", e))?;
            let updated_path = replace_path_prefix(&path, &old_path, &new_folder_path_db)?;
            tx.execute(
                "UPDATE folders SET path = ?1 WHERE id = ?2",
                rusqlite::params![updated_path, folder_id],
            )
            .map_err(|e| format!("Failed to update descendant folder path: {}", e))?;
        }

        let mut note_stmt = tx
            .prepare(
                "SELECT id, path FROM notes
                 WHERE instr(path, ?1) = 1
                   AND (length(path) = length(?1) OR substr(path, length(?1) + 1, 1) = '/')",
            )
            .map_err(|e| format!("Failed to prepare note update query: {}", e))?;
        let note_rows = note_stmt
            .query_map(rusqlite::params![old_path], |row| {
                Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query descendant notes: {}", e))?;

        for row in note_rows {
            let (note_id, path) = row.map_err(|e| format!("Failed to read note row: {}", e))?;
            let updated_path = replace_path_prefix(&path, &old_path, &new_folder_path_db)?;
            tx.execute(
                "UPDATE notes SET path = ?1 WHERE id = ?2",
                rusqlite::params![updated_path, note_id],
            )
            .map_err(|e| format!("Failed to update descendant note path: {}", e))?;
        }

        drop(folder_stmt);
        drop(note_stmt);

        tx.commit()
            .map_err(|e| format!("Failed to commit move transaction: {}", e))?;
        Ok(())
    })();

    if let Err(error) = tx_result {
        let _ = fs::rename(&new_folder_path, &old_path);
        return Err(error);
    }

    Ok(())
}

#[tauri::command]
fn move_item(item_id: &str, target_folder_id: &str) -> Result<(), String> {
    let (item_prefix, raw_item_id) = parse_item_id(item_id)?;
    let (target_prefix, raw_target_folder_id) = parse_item_id(target_folder_id)?;

    if target_prefix != "folder" {
        return Err("Target must be a folder".to_string());
    }

    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    let mut conn = pool.get().map_err(|e| format!("Failed to access database: {}", e))?;

    match item_prefix.as_str() {
        "file" => move_file_record(&mut conn, raw_item_id, raw_target_folder_id),
        "folder" => move_folder_record(&mut conn, raw_item_id, raw_target_folder_id),
        _ => Err("Unknown item type".to_string()),
    }
}

// 列出所有文件和文件夾信息，並更新全局 FILE_LIST
#[tauri::command]
fn list_all_files() -> Vec<FileInfo> {
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
fn get_parent_folders(file_id: &str) -> Vec<String> {
    let pool = match DB_POOL.get() {
        Some(pool) => pool,
        None => return vec![],
    };

    let conn = match pool.get() {
        Ok(conn) => conn,
        Err(_) => return vec![],
    };

    // 以目標節點為起點，先找到第一個父資料夾 id。
    let mut current_parent_id: Option<i32> = if let Some(raw_id) = file_id.strip_prefix("file-") {
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
    } else if let Some(raw_id) = file_id.strip_prefix("folder-") {
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
        .invoke_handler(tauri::generate_handler![greet, list_all_files, get_parent_folders, create_file_in_folder, create_folder_in_folder, delete_item, move_item, save_file_content])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
