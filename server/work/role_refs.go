package work

// CountRoleRefs counts, per agent role id, how many work items name that role.
//
// Roles nothing references are absent rather than present as zero: the map
// goes to clients whole on every change, and a reader already reads a missing
// entry as none.
func CountRoleRefs(works []Work) map[string]int {
	counts := make(map[string]int)
	for _, w := range works {
		if w.AgentRoleID == "" {
			continue
		}
		counts[w.AgentRoleID]++
	}
	return counts
}
