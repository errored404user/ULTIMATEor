--!strict
-- StateMachine.lua (ModuleScript, ReplicatedStorage/Shared)
-- Small, allocation-free finite state machine for NPCs, UI flows and
-- match phases. States are tables with optional Enter / Update / Exit.

export type State<T> = {
	Enter: ((context: T, from: string?) -> ())?,
	Update: ((context: T, dt: number) -> string?)?,
	Exit: ((context: T, to: string) -> ())?,
}

export type Machine<T> = {
	Current: string?,
	Context: T,
	States: { [string]: State<T> },
	Changed: RBXScriptSignal,
	Transition: (self: Machine<T>, to: string) -> (),
	Update: (self: Machine<T>, dt: number) -> (),
	Destroy: (self: Machine<T>) -> (),
}

local StateMachine = {}
StateMachine.__index = StateMachine

function StateMachine.new<T>(context: T, states: { [string]: State<T> }, initial: string): Machine<T>
	local event = Instance.new("BindableEvent")
	local self = setmetatable({
		Current = nil,
		Context = context,
		States = states,
		Changed = event.Event,
		_event = event,
	}, StateMachine) :: any
	self:Transition(initial)
	return self
end

function StateMachine:Transition(to: string)
	local nextState = self.States[to]
	assert(nextState, ("[StateMachine] unknown state '%s'"):format(to))
	local from = self.Current
	if from == to then
		return
	end
	local current = from and self.States[from]
	if current and current.Exit then
		current.Exit(self.Context, to)
	end
	self.Current = to
	if nextState.Enter then
		nextState.Enter(self.Context, from)
	end
	self._event:Fire(from, to)
end

function StateMachine:Update(dt: number)
	local state = self.Current and self.States[self.Current]
	if state and state.Update then
		local nextName = state.Update(self.Context, dt)
		if nextName then
			self:Transition(nextName)
		end
	end
end

function StateMachine:Destroy()
	self._event:Destroy()
	table.clear(self)
end

return StateMachine
