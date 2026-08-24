package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	distDirectory := os.Getenv("NOTEFORGE_DIST_DIR")
	if distDirectory == "" {
		distDirectory = "/app/dist"
	}
	address := os.Getenv("NOTEFORGE_HTTP_ADDRESS")
	if address == "" {
		address = ":8080"
	}

	distFS := os.DirFS(distDirectory)
	indexInfo, err := fs.Stat(distFS, "index.html")
	if err != nil || !indexInfo.Mode().IsRegular() {
		if err == nil {
			err = errors.New("index.html is not a regular file")
		}
		log.Fatalf("NoteForge web distribution is unavailable: %v", err)
	}
	if _, err := fs.ReadFile(distFS, "index.html"); err != nil {
		log.Fatalf("NoteForge web distribution is unavailable: %v", err)
	}

	handler := newAppServer(distFS, os.Stdout, serverOptions{})
	server := &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
		ErrorLog:          log.New(os.Stderr, "noteforge-http: ", log.LstdFlags),
	}

	shutdownContext, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	shutdownComplete := make(chan struct{})
	go func() {
		defer close(shutdownComplete)
		<-shutdownContext.Done()
		deadline, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(deadline); err != nil {
			server.ErrorLog.Printf("graceful shutdown failed: %v", err)
		}
	}()

	log.Printf("NoteForge listening on %s", address)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("NoteForge server failed: %v", err)
	}
	// Shutdown closes the listener before waiting for active requests. Keep the
	// process alive until that wait completes instead of returning from main and
	// cutting in-flight diagnostic/static responses short.
	<-shutdownComplete
}
