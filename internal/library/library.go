package library

import (
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
)

type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
}

type Game struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Engine string `json:"engine"`
	Entry  string `json:"entry"`
	Files  []File `json:"files"`
}

func Scan(root, engine, entry string) (Game, error) {
	game := Game{ID: "default", Title: filepath.Base(root), Engine: engine, Entry: "/" + filepath.ToSlash(entry)}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "savedata" {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		game.Files = append(game.Files, File{Path: "/" + rel, Size: info.Size(), URL: (&url.URL{Path: "/api/files/" + rel}).String()})
		return nil
	})
	if err != nil {
		return Game{}, err
	}
	if _, err := os.Stat(filepath.Join(root, entry)); err != nil {
		return Game{}, err
	}
	return game, nil
}
