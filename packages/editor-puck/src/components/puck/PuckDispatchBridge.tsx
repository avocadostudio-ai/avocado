import { useEffect, type MutableRefObject } from "react"
import { useGetPuck } from "@puckeditor/core"

export function PuckDispatchBridge({
  dispatchRef,
}: {
  dispatchRef: MutableRefObject<((action: any) => void) | null>
}) {
  const getPuck = useGetPuck()

  useEffect(() => {
    dispatchRef.current = (action: any) => getPuck().dispatch(action)
    return () => { dispatchRef.current = null }
  }, [dispatchRef, getPuck])

  return null
}
