import os
import zipfile
import datetime


def zip_backend():
    # Get current directory name
    base_dir = '../backend'
    dir_name = os.path.basename(base_dir)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_filename = f"{dir_name}_{timestamp}.zip"
    
    # Files/Dirs to exclude
    EXCLUDE_DIRS = {
        '.venv', 'venv', '__pycache__', '.git', '.idea', '.vscode', 'logs',
        'node_modules', 'dist', 'build', 'generated', 'comics'
    }
    EXCLUDE_FILES = {
        zip_filename, 'sql_app.db', '.DS_Store', 'Thumbs.db', '.env', 'package_backend.py',
        'Dockerfile'
    }
    # Extensions to exclude
    EXCLUDE_EXTS = {'.pyc', '.pyo', '.pyd', '.log'}
    
    print(f"Packaging backend into {zip_filename}...")
    
    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(base_dir):
            # Modify dirs in-place to skip excluded directories
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            
            for file in files:
                if file in EXCLUDE_FILES:
                    continue
                if any(file.endswith(ext) for ext in EXCLUDE_EXTS):
                    continue
                
                # Full path
                file_path = os.path.join(root, file)
                # Relative path for archive
                arcname = os.path.relpath(file_path, base_dir)
                
                print(f"Adding {arcname}")
                zipf.write(file_path, arcname)
    
    print(f"Done! Created {zip_filename}")


if __name__ == "__main__":
    zip_backend()
