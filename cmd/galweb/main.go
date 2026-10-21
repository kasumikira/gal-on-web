package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"gal-on-web/internal/library"
	"gal-on-web/internal/save"
	"gal-on-web/internal/server"
	webui "gal-on-web/web"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	root := flag.String("game", "", "game directory containing data.xp3")
	webDir := flag.String("web", "", "serve the frontend from this directory instead of the embedded build")
	entry := flag.String("entry", "data.xp3", "game entry relative to game directory")
	savePath := flag.String("save", "tests/savedata.sqlite", "SQLite file holding emulated save data")
	flag.Parse()
	if *root == "" {
		matches, err := filepath.Glob("tests/*/data.xp3")
		if err != nil || len(matches) != 1 {
			log.Fatal("specify -game: expected exactly one tests/*/data.xp3")
		}
		*root = filepath.Dir(matches[0])
	}
	abs, err := filepath.Abs(*root)
	if err != nil {
		log.Fatal(err)
	}
	game, err := library.Scan(abs, *entry)
	if err != nil {
		log.Fatal(err)
	}
	webFS := webui.Build()
	webSource := "embedded web/build"
	if *webDir != "" {
		webFS = os.DirFS(*webDir)
		webSource = *webDir
	}
	saves, err := save.Open(*savePath)
	if err != nil {
		log.Fatal(err)
	}
	defer saves.Close()
	// Keep the database self-describing: a copied file names its game.
	if err := saves.SetMeta("game.id", game.ID); err != nil {
		log.Fatal(err)
	}
	if err := saves.SetMeta("game.entry", game.Entry); err != nil {
		log.Fatal(err)
	}
	log.Printf("%s: %d files; frontend %s; saves in %s; open http://%s", game.Title, len(game.Files), webSource, saves.Path(), *addr)
	log.Fatal(http.ListenAndServe(*addr, server.New(abs, webFS, game, saves)))
}
