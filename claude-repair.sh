#!/bin/bash

# Claude Code Corruption Repair Script
# Detects and fixes common corruption issues in ~/.claude directory
# Can be run standalone or integrated into restart scripts

set -e

CLAUDE_DIR="${HOME}/.claude"
BACKUP_DIR="${HOME}/.claude-backup-$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/tmp/claude-repair.log"
VERBOSE=${VERBOSE:-0}

# Deep scan settings
DEEP_SCAN=${DEEP_SCAN:-0}
DEEP_SCAN_COUNT=${DEEP_SCAN_COUNT:-5}  # Number of recent project files to scan
DEEP_SCAN_TIMEOUT=${DEEP_SCAN_TIMEOUT:-3}  # Seconds to wait for user input

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}✗ ERROR: $*${NC}" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}✓ $*${NC}" | tee -a "$LOG_FILE"
}

warning() {
    echo -e "${YELLOW}⚠ WARNING: $*${NC}" | tee -a "$LOG_FILE"
}

info() {
    echo -e "${BLUE}ℹ $*${NC}" | tee -a "$LOG_FILE"
}

# Check if jq is available for JSON validation
HAS_JQ=0
if command -v jq &> /dev/null; then
    HAS_JQ=1
fi

# Validate JSON file
validate_json() {
    local file="$1"

    if [ ! -f "$file" ]; then
        return 0  # File doesn't exist, skip
    fi

    if [ $HAS_JQ -eq 1 ]; then
        jq empty "$file" 2>/dev/null
        return $?
    else
        python3 -m json.tool "$file" > /dev/null 2>&1
        return $?
    fi
}

# Fix truncated JSONL file (removes incomplete lines from end)
fix_jsonl() {
    local file="$1"
    local temp_file="${file}.tmp"
    local corrupted=0

    if [ ! -f "$file" ]; then
        return 0
    fi

    info "Checking JSONL file: $file"

    # Check each line from the end
    local total_lines=$(wc -l < "$file")
    local valid_lines=0

    while IFS= read -r line; do
        if echo "$line" | python3 -c "import sys, json; json.loads(sys.stdin.read())" 2>/dev/null; then
            valid_lines=$((valid_lines + 1))
        else
            corrupted=1
            break
        fi
    done < <(tac "$file")

    if [ $corrupted -eq 1 ]; then
        local invalid_lines=$((total_lines - valid_lines))
        warning "Found $invalid_lines corrupted line(s) in $file"

        # Create backup
        cp "$file" "${file}.corrupt"

        # Keep only valid lines
        head -n "$valid_lines" "$file" > "$temp_file"
        mv "$temp_file" "$file"

        success "Repaired $file (removed $invalid_lines corrupted lines)"
        return 1
    else
        success "$file is valid"
        return 0
    fi
}

# Repair a corrupted JSON file by attempting to close it
repair_json() {
    local file="$1"

    if [ ! -f "$file" ]; then
        return 0
    fi

    info "Attempting to repair JSON file: $file"

    # Backup the corrupted file
    cp "$file" "${file}.corrupt"

    # Try to intelligently close the JSON
    # This is a simple approach - just try adding closing braces/brackets
    local content=$(cat "$file")

    # Count opening and closing braces
    local open_braces=$(echo "$content" | tr -cd '{' | wc -c)
    local close_braces=$(echo "$content" | tr -cd '}' | wc -c)
    local open_brackets=$(echo "$content" | tr -cd '[' | wc -c)
    local close_brackets=$(echo "$content" | tr -cd ']' | wc -c)

    # Add missing closing characters
    local suffix=""
    for ((i=0; i<$((open_brackets - close_brackets)); i++)); do
        suffix="${suffix}]"
    done
    for ((i=0; i<$((open_braces - close_braces)); i++)); do
        suffix="${suffix}}"
    done

    echo "${content}${suffix}" > "$file"

    if validate_json "$file"; then
        success "Successfully repaired $file"
        return 0
    else
        error "Could not automatically repair $file - creating empty valid JSON"
        # Default to empty object or array based on first character
        if [[ "$content" =~ ^\s*\{ ]]; then
            echo "{}" > "$file"
        else
            echo "[]" > "$file"
        fi
        return 1
    fi
}

# Main repair function
repair_claude_config() {
    log "=== Starting Claude Code Corruption Check ==="

    if [ ! -d "$CLAUDE_DIR" ]; then
        warning "Claude config directory not found: $CLAUDE_DIR"
        info "This is normal if you just reinstalled Claude Code"
        return 0
    fi

    local issues_found=0

    # Create backup
    info "Creating backup: $BACKUP_DIR"
    cp -r "$CLAUDE_DIR" "$BACKUP_DIR"

    # Check and fix JSONL files
    for jsonl_file in "$CLAUDE_DIR"/*.jsonl; do
        if [ -f "$jsonl_file" ]; then
            fix_jsonl "$jsonl_file" || issues_found=$((issues_found + 1))
        fi
    done

    # Check and fix JSON files
    for json_file in "$CLAUDE_DIR"/*.json "$CLAUDE_DIR"/.*.json; do
        if [ -f "$json_file" ]; then
            if ! validate_json "$json_file"; then
                warning "Corrupted JSON detected: $json_file"
                repair_json "$json_file" || issues_found=$((issues_found + 1))
            else
                success "$(basename "$json_file") is valid"
            fi
        fi
    done

    # Check session environment files
    if [ -d "$CLAUDE_DIR/session-env" ]; then
        info "Checking session environment files..."
        local session_issues=0
        for session_file in "$CLAUDE_DIR/session-env"/*; do
            if [ -f "$session_file" ]; then
                if ! validate_json "$session_file" 2>/dev/null; then
                    warning "Removing corrupted session file: $(basename "$session_file")"
                    rm -f "$session_file"
                    session_issues=$((session_issues + 1))
                fi
            fi
        done
        if [ $session_issues -eq 0 ]; then
            success "All session files are valid"
        else
            warning "Removed $session_issues corrupted session file(s)"
            issues_found=$((issues_found + session_issues))
        fi
    fi

    # Summary
    log "=== Repair Summary ==="
    if [ $issues_found -eq 0 ]; then
        success "No corruption detected! All files are valid."
    else
        warning "Fixed $issues_found issue(s)"
        info "Backup saved to: $BACKUP_DIR"
        info "Corrupted files saved with .corrupt extension"
    fi

    log "Repair log saved to: $LOG_FILE"

    return $issues_found
}

# Clean up stale processes (fixes #2: Process State Corruption)
cleanup_stale_processes() {
    log "=== Cleaning Up Stale Processes ==="

    local killed_count=0

    # Find any hung/zombie Claude processes
    local claude_pids=$(pgrep -f "claude" 2>/dev/null | grep -v "$$" || true)

    if [ -n "$claude_pids" ]; then
        info "Found potentially stale Claude processes"

        # Check each process
        for pid in $claude_pids; do
            # Check if process is responsive
            if ! kill -0 "$pid" 2>/dev/null; then
                continue
            fi

            # Check how long it's been running
            local runtime=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' ')

            if [ -n "$runtime" ] && [ "$runtime" -gt 3600 ]; then
                # Process running for more than 1 hour - likely stale
                warning "Killing stale Claude process (PID: $pid, running for ${runtime}s)"
                kill -9 "$pid" 2>/dev/null || true
                killed_count=$((killed_count + 1))
            fi
        done

        if [ $killed_count -gt 0 ]; then
            success "Killed $killed_count stale process(es)"
            sleep 1  # Give processes time to clean up
        else
            success "All Claude processes appear healthy"
        fi
    else
        success "No Claude processes running"
    fi

    return $killed_count
}

# Clean up IPC/socket files and temp state (fixes #2 and #4: Timeout issues)
cleanup_ipc_and_temp_files() {
    log "=== Cleaning Up IPC/Socket/Temp Files ==="

    local cleaned_count=0

    # Clean up /tmp/claude-* files (except logs)
    info "Checking /tmp for stale Claude files..."

    local tmp_files=$(find /tmp -maxdepth 1 -name "claude-*" -type f ! -name "*.log" 2>/dev/null || true)

    if [ -n "$tmp_files" ]; then
        while IFS= read -r file; do
            # Check if file is older than 1 hour
            if [ -f "$file" ]; then
                local age=$(( $(date +%s) - $(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo 0) ))

                if [ "$age" -gt 3600 ]; then
                    warning "Removing stale temp file: $file (age: ${age}s)"
                    rm -f "$file" 2>/dev/null || true
                    cleaned_count=$((cleaned_count + 1))
                fi
            fi
        done <<< "$tmp_files"
    fi

    # Clean up potential socket files
    if [ -d "/tmp" ]; then
        local sockets=$(find /tmp -maxdepth 1 -type s -name "*claude*" 2>/dev/null || true)
        if [ -n "$sockets" ]; then
            while IFS= read -r socket; do
                warning "Removing stale socket: $socket"
                rm -f "$socket" 2>/dev/null || true
                cleaned_count=$((cleaned_count + 1))
            done <<< "$sockets"
        fi
    fi

    # Clean up lock files in ~/.claude
    if [ -d "$CLAUDE_DIR" ]; then
        local locks=$(find "$CLAUDE_DIR" -name "*.lock" -o -name ".lock" 2>/dev/null || true)
        if [ -n "$locks" ]; then
            while IFS= read -r lock; do
                warning "Removing stale lock file: $lock"
                rm -f "$lock" 2>/dev/null || true
                cleaned_count=$((cleaned_count + 1))
            done <<< "$locks"
        fi
    fi

    if [ $cleaned_count -gt 0 ]; then
        success "Cleaned up $cleaned_count stale file(s)"
    else
        success "No stale IPC/temp files found"
    fi

    return $cleaned_count
}

# Reset authentication if corrupted (optional, aggressive fix)
reset_authentication() {
    log "=== Checking Authentication State ==="

    local auth_file="$CLAUDE_DIR/.credentials.json"

    if [ ! -f "$auth_file" ]; then
        info "No authentication file found (will need to login)"
        return 0
    fi

    if validate_json "$auth_file"; then
        success "Authentication file is valid"
        return 0
    else
        warning "Authentication file is corrupted"

        # Backup and remove
        cp "$auth_file" "${auth_file}.corrupt.$(date +%s)"
        rm -f "$auth_file"

        warning "Removed corrupted authentication - you will need to login again"
        return 1
    fi
}

# Scan recent project JSONL files for corruption (deep scan mode)
scan_project_files() {
    log "=== Deep Scan: Checking Recent Project Files ==="

    if [ ! -d "$CLAUDE_DIR/projects" ]; then
        info "No projects directory found"
        return 0
    fi

    local issues_found=0
    local files_checked=0

    # Find recent JSONL files (sorted by modification time)
    info "Scanning $DEEP_SCAN_COUNT most recent project JSONL files..."

    while IFS= read -r filepath; do
        if [ -z "$filepath" ] || [ ! -f "$filepath" ]; then
            continue
        fi

        files_checked=$((files_checked + 1))
        local filename=$(basename "$filepath")
        local size=$(stat -c%s "$filepath" 2>/dev/null || stat -f%z "$filepath" 2>/dev/null || echo 0)

        info "Checking: $filename ($(numfmt --to=iec-i --suffix=B $size 2>/dev/null || echo "${size} bytes"))"

        # Check each line for valid JSON
        local valid_lines=0
        local corrupted_lines=0
        local temp_file="${filepath}.tmp"

        while IFS= read -r line; do
            if [ -z "$line" ]; then
                continue
            fi

            if echo "$line" | python3 -c "import sys, json; json.loads(sys.stdin.read())" 2>/dev/null; then
                valid_lines=$((valid_lines + 1))
                echo "$line" >> "$temp_file"
            else
                corrupted_lines=$((corrupted_lines + 1))
            fi
        done < "$filepath"

        if [ $corrupted_lines -gt 0 ]; then
            warning "Found $corrupted_lines corrupted line(s) in $filename"

            # Backup and replace
            cp "$filepath" "${filepath}.corrupt"
            mv "$temp_file" "$filepath"

            success "Repaired $filename (kept $valid_lines valid lines)"
            issues_found=$((issues_found + 1))
        else
            rm -f "$temp_file"
            success "$filename is valid ($valid_lines lines)"
        fi
    done < <(find "$CLAUDE_DIR/projects" -name "*.jsonl" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n "$DEEP_SCAN_COUNT" | cut -d' ' -f2-)

    log "Checked $files_checked project file(s), fixed $issues_found"
    return $issues_found
}

# Prompt user for deep scan option
prompt_deep_scan() {
    if [ -t 0 ]; then  # Only prompt if running in interactive terminal
        echo -e "${YELLOW}Press 'D' within ${DEEP_SCAN_TIMEOUT} seconds for deep scan (checks recent project files)...${NC}"

        if read -t "$DEEP_SCAN_TIMEOUT" -n 1 -r key; then
            echo ""  # New line after key press
            if [[ $key =~ ^[Dd]$ ]]; then
                DEEP_SCAN=1
                info "Deep scan enabled!"
                return 0
            fi
        fi
        echo ""  # New line after timeout
    fi

    return 1
}

# Check Claude Code installation integrity
check_claude_installation() {
    log "=== Checking Claude Code Installation ==="

    # Try multiple methods to find claude binary
    local claude_bin=$(which claude 2>/dev/null)

    # If not in PATH, check common installation locations
    if [ -z "$claude_bin" ]; then
        if [ -f "$HOME/.local/bin/claude" ]; then
            claude_bin="$HOME/.local/bin/claude"
        elif [ -f "/usr/local/bin/claude" ]; then
            claude_bin="/usr/local/bin/claude"
        fi
    fi

    if [ -z "$claude_bin" ]; then
        error "Claude Code binary not found in PATH or common locations"
        info "Checked: which claude, ~/.local/bin/claude, /usr/local/bin/claude"
        info "For native installation, ensure ~/.local/bin is in your PATH"
        return 1
    fi

    info "Claude Code found at: $claude_bin"

    # Detect installation type
    local install_type="unknown"
    if [[ "$claude_bin" == *"/.local/bin/claude"* ]] || [[ "$claude_bin" == *"/.local/share/claude/"* ]]; then
        install_type="native"
    elif [[ "$claude_bin" == *"/node_modules/"* ]] || [[ "$claude_bin" == *"npm"* ]]; then
        install_type="npm"
    fi

    # Check if it's a symlink
    if [ -L "$claude_bin" ]; then
        local target=$(readlink -f "$claude_bin")
        info "Symlink target: $target"

        if [ ! -f "$target" ]; then
            error "Symlink target does not exist: $target"
            return 1
        fi

        # Check if the binary is executable and not corrupted (not 0 bytes)
        local size=$(stat -f%z "$target" 2>/dev/null || stat -c%s "$target" 2>/dev/null)
        if [ "$size" -eq 0 ]; then
            error "Claude Code binary is corrupted (0 bytes): $target"
            return 1
        fi

        success "Claude Code installation appears intact ($install_type, size: ${size} bytes)"
    else
        # Not a symlink, check if it's the native binary directly
        if [ -f "$claude_bin" ]; then
            local size=$(stat -f%z "$claude_bin" 2>/dev/null || stat -c%s "$claude_bin" 2>/dev/null)
            success "Claude Code installation appears intact ($install_type, size: ${size} bytes)"
        fi
    fi

    # Try to run claude --version using the found binary
    if timeout 5 "$claude_bin" --version &>/dev/null; then
        local version=$("$claude_bin" --version 2>/dev/null || echo "unknown")
        success "Claude Code is responsive ($install_type: $version)"
        return 0
    else
        error "Claude Code is not responding to commands"
        return 1
    fi
}

# Main execution
main() {
    echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Claude Code Corruption Repair Tool     ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
    echo ""

    > "$LOG_FILE"  # Clear log file

    # Prompt for deep scan (unless already set via env var)
    if [ $DEEP_SCAN -eq 0 ]; then
        prompt_deep_scan
    fi

    # Check installation
    if ! check_claude_installation; then
        error "Claude Code installation issues detected"
        info "You may need to reinstall: curl -fsSL https://claude.ai/install.sh | bash"
    fi

    echo ""

    # Clean up stale processes (fixes #2: Process State Corruption)
    cleanup_stale_processes || true  # Don't exit on non-zero return

    echo ""

    # Clean up IPC/temp files (fixes #2 and #4: Timeout issues)
    cleanup_ipc_and_temp_files || true  # Don't exit on non-zero return

    echo ""

    # Repair config (fixes #1: Config File Corruption)
    repair_claude_config || true  # Don't exit on non-zero return

    echo ""

    # Check authentication state
    reset_authentication || true  # Don't exit on non-zero return

    echo ""

    # Deep scan project files if requested
    if [ $DEEP_SCAN -eq 1 ]; then
        scan_project_files || true  # Don't exit on non-zero return
        echo ""
    fi

    log "=== Complete ==="
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
