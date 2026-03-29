import { useEffect, useState } from "react"
import { fetchPlannerFeatures } from "./draft-api"
import type { PlannerFeatures } from "./types"

export function usePuckPlannerFeatures() {
  const [backendFeatures, setBackendFeatures] = useState<PlannerFeatures>({})

  useEffect(() => {
    let active = true

    const checkPlannerStatus = async () => {
      const next = await fetchPlannerFeatures()
      if (!active || !next) return
      setBackendFeatures((prev) => (
        prev.googleDrive === next.googleDrive
          && prev.unsplash === next.unsplash
          && prev.imageGenerate === next.imageGenerate
          && prev.imageGenerateChat === next.imageGenerateChat
      ) ? prev : next)
    }

    void checkPlannerStatus()
    return () => { active = false }
  }, [])

  return backendFeatures
}
