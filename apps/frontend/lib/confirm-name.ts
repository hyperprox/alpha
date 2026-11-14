// "Type the name to confirm": exact, and never satisfied by an empty name.
export const deleteNameOk = (typed: string, name: string): boolean => name.length > 0 && typed === name
