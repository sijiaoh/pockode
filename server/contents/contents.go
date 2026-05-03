// Package contents provides file system browsing and reading.
package contents

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrInvalidPath = errors.New("invalid path")
)

// ValidatePath checks if path is safe and within workDir.
// Returns ErrInvalidPath for path traversal attempts or absolute paths.
func ValidatePath(workDir, path string) error {
	if path == "" {
		return nil
	}

	cleanPath := filepath.Clean(path)
	if strings.HasPrefix(cleanPath, "..") || filepath.IsAbs(cleanPath) {
		return fmt.Errorf("%w: %s", ErrInvalidPath, path)
	}

	fullPath := filepath.Join(workDir, cleanPath)
	if !strings.HasPrefix(fullPath, workDir+string(filepath.Separator)) {
		return fmt.Errorf("%w: %s", ErrInvalidPath, path)
	}

	return nil
}

type EntryType string

const (
	TypeFile EntryType = "file"
	TypeDir  EntryType = "dir"
)

type Encoding string

const (
	EncodingText   Encoding = "text"
	EncodingBase64 Encoding = "base64"
)

type Entry struct {
	Name string    `json:"name"`
	Type EntryType `json:"type"`
	Path string    `json:"path"`
}

type FileContent struct {
	Name     string    `json:"name"`
	Type     EntryType `json:"type"`
	Path     string    `json:"path"`
	Content  string    `json:"content"`
	Encoding Encoding  `json:"encoding"`
}

// ContentsResult holds the result of GetContents.
// Either Entries (for directories) or File (for files) is set, never both.
type ContentsResult struct {
	Entries []Entry      // Directory listing (nil if file)
	File    *FileContent // File content (nil if directory)
}

// IsDir returns true if the result is a directory listing.
func (r ContentsResult) IsDir() bool {
	return r.File == nil
}

// GetContents returns directory entries or file content.
// Returns ErrNotFound if path doesn't exist, ErrInvalidPath for path traversal attempts.
func GetContents(workDir, path string) (ContentsResult, error) {
	if err := ValidatePath(workDir, path); err != nil {
		return ContentsResult{}, err
	}

	fullPath := filepath.Join(workDir, path)
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return ContentsResult{}, fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return ContentsResult{}, fmt.Errorf("failed to stat path: %w", err)
	}

	if info.IsDir() {
		entries, err := listDir(path, fullPath)
		if err != nil {
			return ContentsResult{}, err
		}
		return ContentsResult{Entries: entries}, nil
	}

	file, err := readFile(path, fullPath, info)
	if err != nil {
		return ContentsResult{}, err
	}
	return ContentsResult{File: file}, nil
}

func listDir(relPath, fullPath string) ([]Entry, error) {
	dirEntries, err := os.ReadDir(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	entries := make([]Entry, 0, len(dirEntries))
	for _, de := range dirEntries {
		entryPath := de.Name()
		if relPath != "" {
			entryPath = relPath + "/" + de.Name()
		}
		entry := Entry{
			Name: de.Name(),
			Path: entryPath,
		}

		if de.IsDir() {
			entry.Type = TypeDir
		} else {
			entry.Type = TypeFile
		}

		entries = append(entries, entry)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == TypeDir
		}
		return entries[i].Name < entries[j].Name
	})

	return entries, nil
}

func readFile(relPath, fullPath string, info os.FileInfo) (*FileContent, error) {
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	encoding := EncodingText
	contentStr := string(content)

	if isBinary(content) {
		encoding = EncodingBase64
		contentStr = base64.StdEncoding.EncodeToString(content)
	}

	return &FileContent{
		Name:     info.Name(),
		Type:     TypeFile,
		Path:     relPath,
		Content:  contentStr,
		Encoding: encoding,
	}, nil
}

// isBinary detects binary content by checking for null bytes in the first 512 bytes.
func isBinary(content []byte) bool {
	checkLen := min(512, len(content))
	for i := 0; i < checkLen; i++ {
		if content[i] == 0 {
			return true
		}
	}
	return false
}

// WriteFile writes content to a file within workDir.
// Creates the file and parent directories if they don't exist.
// Returns ErrInvalidPath for path traversal attempts, absolute paths, or empty paths.
func WriteFile(workDir, path, content string) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	fullPath := filepath.Join(workDir, path)

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create parent directories: %w", err)
	}

	return os.WriteFile(fullPath, []byte(content), 0644)
}

// Delete removes a file or directory within workDir.
// For directories, it recursively removes all contents.
// Returns ErrInvalidPath for path traversal attempts, absolute paths, or empty paths.
// Returns ErrNotFound if the path doesn't exist.
func Delete(workDir, path string) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	fullPath := filepath.Join(workDir, path)

	if _, err := os.Stat(fullPath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return fmt.Errorf("failed to stat path: %w", err)
	}

	return os.RemoveAll(fullPath)
}

// DeleteFile deletes a file within workDir.
// Deprecated: Use Delete instead, which handles both files and directories.
func DeleteFile(workDir, path string) error {
	return Delete(workDir, path)
}
