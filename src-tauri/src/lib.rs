use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
    filetype: FileType,
    content: String,
    children: Option<Vec<FileInfo>>,
}

// 獲取指定目錄下的所有文件和文件夾信息
#[tauri::command]
fn get_files(dirpath: &str, now_id: &str) -> Vec<FileInfo> {
    let path = PathBuf::from(&dirpath);
    if !(path.exists() && path.is_dir()) {
        return vec![];
    }

    let mut files = Vec::new();
    let mut id_counter: i32 = 1;

    match fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => {
                        // println!("{:?}", entry.metadata());
                        let file_type = if let Ok(metadata) = entry.metadata() {
                            if metadata.is_dir() {
                                FileType::Folder
                            } else {
                                FileType::File
                            }
                        } else {
                            FileType::File // Default to File if metadata cannot be read
                        };

                        let mut file_info = FileInfo {
                            id: now_id.to_string() + &id_counter.to_string(),
                            name: entry.file_name().to_string_lossy().to_string(),
                            filetype: file_type,
                            content: String::new(),
                            children: None,
                        };
                        if file_info.filetype == FileType::Folder {
                            println!("Folder: {}", file_info.name);
                            let subfolder_files: Vec<FileInfo> = get_files(&entry.path().to_string_lossy().to_string(), &format!("{}-", file_info.id));
                            file_info.children = Some(subfolder_files);
                        } else {
                            file_info.content = get_file_content(&entry.path().to_string_lossy().to_string());
                            println!("File: {}", file_info.name);
                        }
                        files.push(file_info);
                        id_counter += 1;
                    }
                    Err(_) => continue,
                }
            }
        }
        Err(e) => Err(e.to_string()).unwrap_or_else(|err| {
            eprintln!("Error reading directory: {}", err);
        }),
    }
    files
}

fn get_file_content(file_path: &str) -> String {
    match fs::read_to_string(file_path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("Error reading file: {}", e);
            String::new()
        }
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, get_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
