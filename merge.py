import os

# 输出文件
OUTPUT_FILE = "merged.txt"

# 允许的文件扩展名
ALLOWED_EXT = {'.py', '.md', '.js', '.html', '.txt'}

# 忽略目录
IGNORE_DIRS = {'.git', '__pycache__', 'node_modules', '.idea', '.vscode', 'data'}

def build_tree(root):
    """生成目录树字符串"""
    tree_lines = []

    def dfs(path, prefix=""):
        entries = sorted(os.listdir(path))
        entries = [e for e in entries if e not in IGNORE_DIRS and not e.startswith('.')]
        for i, name in enumerate(entries):
            full = os.path.join(path, name)
            connector = "└── " if i == len(entries) - 1 else "├── "
            if os.path.isdir(full):
                tree_lines.append(prefix + connector + name + "/")
                dfs(full, prefix + ("    " if i == len(entries) - 1 else "│   "))
            else:
                ext = os.path.splitext(name)[1]
                if ext in ALLOWED_EXT and name != os.path.basename(__file__) and name != OUTPUT_FILE:
                    tree_lines.append(prefix + connector + name)

    tree_lines.append(os.path.basename(os.path.abspath(root)) + "/")
    dfs(root)
    return "\n".join(tree_lines)

def collect_files(root):
    """收集所有允许的文件的相对路径"""
    paths = []
    for dirpath, dirnames, filenames in os.walk(root):
        # 过滤目录
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith('.')]
        for f in sorted(filenames):
            if f in {os.path.basename(__file__), OUTPUT_FILE}:
                continue
            if os.path.splitext(f)[1] in ALLOWED_EXT:
                paths.append(os.path.relpath(os.path.join(dirpath, f), root))
    return paths

def main():
    root = "."
    print(f"正在生成 {OUTPUT_FILE} ...")

    # 写入目录结构
    with open(OUTPUT_FILE, "w", encoding="utf-8") as out:
        out.write("### 文件结构\n\n")
        out.write("```\n" + build_tree(root) + "\n```\n\n")
        out.write("### 文件内容\n\n")

    # 写入文件内容
    with open(OUTPUT_FILE, "a", encoding="utf-8") as out:
        for relpath in collect_files(root):
            out.write(f"\n\n---\n# {relpath}\n\n")
            with open(relpath, "r", encoding="utf-8", errors="ignore") as f:
                out.write(f.read())

    print(f"✅ 合并完成，共输出到 {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
