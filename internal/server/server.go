package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"gal-on-web/internal/library"
	"gal-on-web/internal/save"
)

// maxSaveSize bounds one uploaded save file; the engine writes small data files.
const maxSaveSize = 256 << 20

func New(root string, webFS fs.FS, game library.Game, saves *save.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/game", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(game)
	})
	files := http.FileServerFS(os.DirFS(root))
	mux.Handle("/api/files/", http.StripPrefix("/api/files/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		// Every game read must be bounded. Never serve an entire archive as a fallback.
		if r.Method == http.MethodGet && !strings.HasPrefix(r.Header.Get("Range"), "bytes=") {
			http.Error(w, "game resources require HTTP Range", http.StatusBadRequest)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		log.Printf("resource %s %s %s", r.Method, r.URL.Path, r.Header.Get("Range"))
		files.ServeHTTP(w, r)
	})))
	// Save backend: the engine's list/read/write map onto rows of a SQLite file,
	// so a reproduced save set is one copyable database.
	mux.HandleFunc("GET /api/saves", func(w http.ResponseWriter, r *http.Request) {
		list, err := saves.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, list)
	})
	mux.HandleFunc("GET /api/save-store", func(w http.ResponseWriter, r *http.Request) {
		meta, err := saves.Meta()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{
			"database": saves.Path(),
			"game":     map[string]string{"id": game.ID, "title": game.Title, "entry": game.Entry},
			"meta":     meta,
		})
	})
	mux.HandleFunc("GET /api/saves/{path...}", func(w http.ResponseWriter, r *http.Request) {
		serveSave(w, r, saves)
	})
	mux.HandleFunc("PUT /api/saves/{path...}", func(w http.ResponseWriter, r *http.Request) {
		name := savePath(r)
		body := http.MaxBytesReader(w, r.Body, maxSaveSize)
		data, err := io.ReadAll(body)
		if err != nil {
			http.Error(w, "read save body: "+err.Error(), http.StatusBadRequest)
			return
		}
		file, err := saves.Write(name, data)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("save write %s %d bytes", file.Path, file.Size)
		writeJSON(w, file)
	})
	mux.HandleFunc("DELETE /api/saves/{path...}", func(w http.ResponseWriter, r *http.Request) {
		name := savePath(r)
		removed, err := saves.Delete(name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !removed {
			http.Error(w, "save file not found: "+name, http.StatusNotFound)
			return
		}
		log.Printf("save delete %s", name)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", staticHandler(webFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Required by the WASM engine's shared memory and worker protocol.
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(value)
}

// savePath rebuilds the engine's virtual absolute path from the request.
func savePath(r *http.Request) string {
	return "/" + r.PathValue("path")
}

// serveSave answers list/read requests with ordinary HTTP semantics, so the
// engine's range reads behave exactly like they do against real files.
func serveSave(w http.ResponseWriter, r *http.Request, saves *save.Store) {
	name := savePath(r)
	size, err := saves.Size(name)
	if errors.Is(err, save.ErrNotFound) {
		http.Error(w, "save file not found: "+name, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, name, time.Time{}, &saveReader{store: saves, name: name, size: size})
}

// saveReader streams a stored BLOB without loading all of it.
type saveReader struct {
	store *save.Store
	name  string
	size  int64
	at    int64
}

func (reader *saveReader) Read(p []byte) (int, error) {
	if reader.at >= reader.size {
		return 0, io.EOF
	}
	length := int64(len(p))
	if remaining := reader.size - reader.at; length > remaining {
		length = remaining
	}
	data, err := reader.store.Read(reader.name, reader.at, length)
	if err != nil {
		return 0, err
	}
	copy(p, data)
	reader.at += int64(len(data))
	return len(data), nil
}

func (reader *saveReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		reader.at = offset
	case io.SeekCurrent:
		reader.at += offset
	case io.SeekEnd:
		reader.at = reader.size + offset
	}
	if reader.at < 0 {
		return 0, errors.New("negative save offset")
	}
	return reader.at, nil
}

// staticHandler serves the frontend and supplies a validator for each file.
// Embedded files carry a zero modification time, so hashing their contents
// distinguishes revisions of the same URL across binary builds.
func staticHandler(webFS fs.FS) http.Handler {
	cache := &etagCache{files: webFS, entries: make(map[string]etagEntry)}
	files := http.FileServerFS(webFS)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Frontend files are revalidated so changed code is never served from a
		// stale cache; the validator distinguishes every revision of a file.
		if etag, ok := cache.get(r.URL.Path); ok {
			w.Header().Set("Etag", etag)
		}
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
}

type etagCache struct {
	files   fs.FS
	mu      sync.Mutex
	entries map[string]etagEntry
}

type etagEntry struct {
	size    int64
	modTime time.Time
	tag     string
}

func (cache *etagCache) get(urlPath string) (string, bool) {
	name, info, err := resolveStatic(cache.files, urlPath)
	if err != nil {
		return "", false
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if entry, ok := cache.entries[name]; ok && entry.size == info.Size() && entry.modTime.Equal(info.ModTime()) {
		return entry.tag, true
	}
	file, err := cache.files.Open(name)
	if err != nil {
		return "", false
	}
	defer file.Close()
	hash := fnv.New64a()
	if _, err := io.Copy(hash, file); err != nil {
		return "", false
	}
	entry := etagEntry{
		size:    info.Size(),
		modTime: info.ModTime(),
		tag:     fmt.Sprintf("\"%x-%x\"", info.Size(), hash.Sum64()),
	}
	cache.entries[name] = entry
	return entry.tag, true
}

// resolveStatic finds the file the static handler serves for a URL path,
// following a directory request to its index.html.
func resolveStatic(files fs.FS, urlPath string) (string, fs.FileInfo, error) {
	name := strings.TrimPrefix(path.Clean("/"+urlPath), "/")
	if name == "" {
		name = "."
	}
	info, err := fs.Stat(files, name)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() {
		return name, info, nil
	}
	index := path.Join(name, "index.html")
	info, err = fs.Stat(files, index)
	if err != nil {
		return "", nil, err
	}
	return index, info, nil
}
