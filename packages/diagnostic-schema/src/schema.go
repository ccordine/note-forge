// Package diagnosticschema owns the wire-level diagnostic version and allowlists.
package diagnosticschema

import (
	_ "embed"
	"encoding/json"
)

//go:embed schema.json
var encodedSchema []byte

type schemaDocument struct {
	Version          int             `json:"version"`
	Flows            map[string]bool `json:"flows"`
	ObservationKinds map[string]bool `json:"observationKinds"`
}

var currentSchema = func() schemaDocument {
	var document schemaDocument
	if err := json.Unmarshal(encodedSchema, &document); err != nil {
		panic("invalid embedded diagnostic schema: " + err.Error())
	}
	if document.Version <= 0 || len(document.Flows) == 0 || len(document.ObservationKinds) == 0 {
		panic("embedded diagnostic schema is empty")
	}
	for flow, enabled := range document.Flows {
		if flow == "" || !enabled {
			panic("embedded diagnostic schema contains an invalid flow")
		}
	}
	for kind, enabled := range document.ObservationKinds {
		if kind == "" || !enabled {
			panic("embedded diagnostic schema contains an invalid observation kind")
		}
	}
	return document
}()

// Version is the only accepted diagnostic wire schema version.
func Version() int {
	return currentSchema.Version
}

// ValidFlow reports whether a client flow is in the shared wire allowlist.
func ValidFlow(flow string) bool {
	return currentSchema.Flows[flow]
}

// ValidObservationKind reports whether kind is part of the shared wire contract.
func ValidObservationKind(kind string) bool {
	return currentSchema.ObservationKinds[kind]
}
