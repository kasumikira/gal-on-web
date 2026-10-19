// Package save keeps emulated save files in a SQLite database. Each file is one
// row whose bytes are stored as a BLOB, so a save set is a single portable file
// that can be copied next to a bug report and inspected with any SQLite client.
//
// This is a development backend: the engine only needs list/read/write, so the
// storage layout stays deliberately simple instead of mirroring the original
// per-game save directory.
package save

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// File describes one stored save file.
type File struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Store is the SQLite-backed save backend.
type Store struct {
	db   *sql.DB
	path string
}

// ErrNotFound reports a read/delete of a file that was never written.
var ErrNotFound = errors.New("save file not found")

const schema = `
CREATE TABLE IF NOT EXISTS files (
	path TEXT PRIMARY KEY,
	data BLOB NOT NULL,
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) WITHOUT ROWID;
`

// Open opens (and creates) the database file. Missing parent directories are
// created so a fresh checkout only needs the game itself.
func Open(name string) (*Store, error) {
	abs, err := filepath.Abs(name)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	// One connection serializes writers, which is what a dev server needs; the
	// busy timeout covers readers that still overlap a write. The pragma is a
	// statement rather than a DSN parameter so the path stays a plain filename
	// (SQLite URI syntax would misread drive letters and backslashes).
	db, err := sql.Open("sqlite", abs)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create save schema: %w", err)
	}
	return &Store{db: db, path: abs}, nil
}

// Path is the absolute database file path, for logging and quick inspection.
func (s *Store) Path() string { return s.path }

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// SetMeta records a self-describing key (game id, entry, ...) so a copied
// database says which game produced it.
func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO meta(key, value) VALUES(?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// Meta returns all recorded keys.
func (s *Store) Meta() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key, value FROM meta ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		values[key] = value
	}
	return values, rows.Err()
}

// List returns every stored file with its size and last write time.
func (s *Store) List() ([]File, error) {
	rows, err := s.db.Query(`SELECT path, length(data), updated_at FROM files ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files := []File{}
	for rows.Next() {
		var file File
		if err := rows.Scan(&file.Path, &file.Size, &file.UpdatedAt); err != nil {
			return nil, err
		}
		files = append(files, file)
	}
	return files, rows.Err()
}

// Read returns the requested byte range. SQLite slices the BLOB itself, so a
// range read never materializes the whole file.
func (s *Store) Read(name string, offset, length int64) ([]byte, error) {
	if offset < 0 || length < 0 {
		return nil, fmt.Errorf("invalid range %d+%d", offset, length)
	}
	var data []byte
	err := s.db.QueryRow(`SELECT substr(data, ?, ?) FROM files WHERE path = ?`,
		offset+1, length, Normalize(name)).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	if err != nil {
		return nil, err
	}
	if data == nil {
		data = []byte{}
	}
	return data, nil
}

// Size reports the stored size, which callers need to answer range requests.
func (s *Store) Size(name string) (int64, error) {
	var size int64
	err := s.db.QueryRow(`SELECT length(data) FROM files WHERE path = ?`, Normalize(name)).Scan(&size)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	return size, err
}

// Write replaces or creates one file.
func (s *Store) Write(name string, data []byte) (File, error) {
	if data == nil {
		data = []byte{}
	}
	file := File{Path: Normalize(name), Size: int64(len(data)), UpdatedAt: time.Now().UnixMilli()}
	_, err := s.db.Exec(`INSERT INTO files(path, data, updated_at) VALUES(?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		file.Path, data, file.UpdatedAt)
	return file, err
}

// Delete removes one file and reports whether it existed.
func (s *Store) Delete(name string) (bool, error) {
	result, err := s.db.Exec(`DELETE FROM files WHERE path = ?`, Normalize(name))
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count > 0, err
}

// Normalize keeps the engine's virtual absolute spelling but removes empty and
// relative segments, so "/a//../b" and "/b" name the same row.
func Normalize(name string) string {
	cleaned := path.Clean("/" + strings.ReplaceAll(name, "\\", "/"))
	if cleaned == "." {
		return "/"
	}
	return cleaned
}
